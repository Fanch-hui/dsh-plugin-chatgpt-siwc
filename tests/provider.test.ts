import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import WebSocket, { WebSocketServer } from 'ws'
import { BlockAssembler, createAssistantMessage, createSystemMessage, ReasoningEffortId, ToolCallId, offloadedImageText, requestImageHandleText,
  type GenerateOptions, type StreamChunk, type ImageBlock } from '@deepseek-ai/dsh-llm'
import { AssistantStreamAccumulator, expandAssistantStream } from '@deepseek-ai/dsh-llm/assistant-stream'
import { ChatGPTSiwcAdapter, type ProviderConnection } from '../src/provider/adapter.js'
import { ProviderError } from '../src/provider/errors.js'
import { buildRequest } from '../src/provider/request.js'
import { parseStream } from '../src/provider/stream.js'
import { readResponseEvents } from '../src/provider/sse.js'
import { projectTools, toolIdentity } from '../src/provider/tools.js'

const context = { connectionId: 'fixture-registration', model: 'fixture-model' }

test('HTTP stream failures retain request metadata through the shared event transport', async () => {
  const response = new Response('data: {"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}}\n\n',
    {headers: {'x-request-id': 'req-fixture', 'retry-after': '3'}})
  await assert.rejects(async () => {
    for await (const _event of readResponseEvents(response)) {}
  }, (error: unknown) => error instanceof ProviderError && error.code === 'QUOTA' &&
    error.failure.requestId === 'req-fixture' && error.failure.providerRetryAfterMs === 3000)
})
const toolSchemas = [
  { name: 'file.read', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'file_read', description: 'Other', parameters: { type: 'object' } },
]
function options(extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'chatgpt-siwc', model: context.model, messages: [], ...extra }
}
function sse(events: object[], byteChunks = false): Response {
  const bytes = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''))
  let offset = 0
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) return controller.close()
      const size = byteChunks ? 1 : bytes.length
      controller.enqueue(bytes.slice(offset, offset + size))
      offset += size
    },
  }), { headers: { 'content-type': 'text/event-stream' } })
}
async function collect(response: Response, identities = projectTools(toolSchemas).identities) {
  const chunks: StreamChunk[] = []
  for await (const chunk of parseStream(response, identities, context)) chunks.push(chunk)
  return chunks
}

test('request preserves current history, uses namespace tools, and rejects unsupported parameters', async () => {
  const result = await buildRequest(options({ system: 'one-shot', tools: toolSchemas, messages: [
    createSystemMessage('system'),
    { role: 'user', content: [{ type: 'text', text: '你好' }] },
    createAssistantMessage({ source: { provider: 'other', model: 'other' }, content: [
      { type: 'tool-call', id: ToolCallId('call-fixture'), name: 'file.read', arguments: '{"path":"a"}' },
    ] }),
  ] }), context)
  assert.equal(result.body.store, false)
  assert.equal(result.body.stream, true)
  assert.equal(result.body.instructions, 'one-shot')
  const input = result.body.input as Record<string, unknown>[]
  assert.equal(input[0].role, 'developer')
  assert.equal(input[2].call_id, 'call-fixture')
  assert.equal(input[2].name, toolIdentity('file.read').name)
  assert.notEqual(result.identities[0].name, result.identities[1].name)
  assert.deepEqual((result.body.tools as object[])[0], {
    type: 'namespace', name: 'dsh', description: 'Tools provided by the DSH runtime.',
    tools: toolSchemas.map((tool, i) => ({ type: 'function', name: result.identities[i].name,
      description: tool.description, parameters: tool.parameters, strict: false })),
  })
  await assert.rejects(buildRequest(options({ maxTokens: 100 }), context), { code: 'SIWC_UNSUPPORTED_PARAMETER' })
})

test('SSE preserves Chinese and emoji across byte chunks and emits usage before finish', async () => {
  const item = { type: 'message', id: 'msg_fixture', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '中文😀' }] }
  const chunks = await collect(sse([
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: '中文😀' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { output: [item], usage: {
      input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 40 },
    } } },
  ], true))
  assert.deepEqual(chunks.map(chunk => chunk.type), ['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
  assert.deepEqual(chunks[3], { type: 'usage', usage: { inputTokens: 60, cacheReadTokens: 40, outputTokens: 10, totalTokens: 110 } })
  const end = chunks.find(chunk => chunk.type === 'block-end')
  assert.deepEqual(end?.block, { type: 'text', text: '中文😀' })
})

test('DSH durable stream accepts text, reasoning and tools with native replay intact', async () => {
  const identity = toolIdentity('file.read')
  const outputs = [
    { type: 'reasoning', id: 'rs_durable', encrypted_content: 'synthetic-reasoning', summary: [] },
    { type: 'message', id: 'msg_durable', role: 'assistant', content: [{ type: 'output_text', text: '读取文件' }] },
    { type: 'function_call', id: 'fc_durable', call_id: 'call_durable', namespace: identity.namespace,
      name: identity.name, arguments: '{"path":"fixture"}' },
  ]
  const accumulator = new AssistantStreamAccumulator()
  const timed = []
  for await (const chunk of parseStream(sse([
    { type: 'response.completed', response: { id: 'resp_durable', output: outputs,
      usage: { input_tokens: 10, output_tokens: 5 } } },
  ]), [identity], context)) {
    timed.push(accumulator.push({ time: timed.length, chunk }))
  }
  const restored = expandAssistantStream(JSON.parse(JSON.stringify(accumulator.snapshot())))
  assert.deepEqual(restored, timed)
  const assembler = new BlockAssembler()
  for (const { chunk } of restored) assembler.push(chunk)
  assert.equal((assembler.replayState?.response as { responseId: string }).responseId, 'resp_durable')
  const assistant = assembler.message({ provider: 'chatgpt-siwc', model: context.model,
    replayState: assembler.replayState })
  const replayed = await buildRequest(options({ messages: [assistant] }), context)
  assert.deepEqual(replayed.body.input, outputs)
})

test('interleaved tools keep distinct call ids and raw argument deltas', async () => {
  const identities = projectTools(toolSchemas).identities
  const items = identities.map((tool, i) => ({ type: 'function_call', id: `fc_${i}`, call_id: `call_${i}`, namespace: tool.namespace, name: tool.name, arguments: '{"ok":true}' }))
  const chunks = await collect(sse([
    ...items.map((item, output_index) => ({ type: 'response.output_item.added', output_index, item: { ...item, arguments: '' } })),
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"ok":' },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"ok":true}' },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: 'true}' },
    ...items.map((item, output_index) => ({ type: 'response.output_item.done', output_index, item })),
    { type: 'response.completed', response: { output: items } },
  ]))
  const ended = chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
  assert.deepEqual(ended, toolSchemas.map((tool, i) => ({ type: 'tool-call', id: `call_${i}`, name: tool.name, arguments: '{"ok":true}' })))
  const finish = chunks.at(-1)
  assert.equal(finish?.type === 'finish' && finish.reason.kind, 'tool-calls')
  const replay = finish?.type === 'finish' ? finish.replayState : undefined
  const assistant = createAssistantMessage({ source: { provider: 'chatgpt-siwc', model: context.model, replayState: replay }, content: ended })
  const replayed = await buildRequest(options({ messages: [assistant] }), context)
  assert.equal((replayed.body.input as Record<string, unknown>[])[1].id, 'fc_1')
  assert.equal((replayed.body.input as Record<string, unknown>[])[1].call_id, 'call_1')
})

test('encrypted reasoning follows retained blocks and registration identity', async () => {
  const reasoning = { type: 'reasoning', id: 'rs_fixture', encrypted_content: 'synthetic-encrypted-data', summary: [{ type: 'summary_text', text: '推理' }] }
  const text = { type: 'message', id: 'msg_fixture', role: 'assistant', content: [{ type: 'output_text', text: '回答' }] }
  const chunks = await collect(sse([{ type: 'response.completed', response: { output: [reasoning, text] } }]))
  const blocks = chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
  const finish = chunks.at(-1)
  const envelope = finish?.type === 'finish' ? finish.replayState : undefined
  const assistant = createAssistantMessage({ source: { provider: 'chatgpt-siwc', model: context.model, replayState: envelope }, content: blocks })
  const replayed = await buildRequest(options({ messages: [assistant] }), context)
  assert.equal((replayed.body.input as Record<string, unknown>[])[0].encrypted_content, 'synthetic-encrypted-data')
  const changed = createAssistantMessage({ source: { provider: 'chatgpt-siwc', model: context.model, replayState: envelope }, content: [{ type: 'reasoning', text: 'compressed' }, blocks[1]] })
  const compressed = await buildRequest(options({ messages: [changed] }), context)
  assert.equal((compressed.body.input as object[]).length, 1)
  const otherAccount = await buildRequest(options({ messages: [assistant] }), { ...context, connectionId: 'other' })
  assert.equal((otherAccount.body.input as object[]).length, 1)
})

test('failed, incomplete and interrupted streams fail after closing visible blocks', async () => {
  for (const terminal of [
    { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'private fixture details' } } },
    { type: 'response.incomplete', response: {} },
  ]) {
    const chunks: StreamChunk[] = []
    await assert.rejects(async () => {
      for await (const chunk of parseStream(sse([
        { type: 'response.output_text.delta', output_index: 0, delta: 'partial' }, terminal,
      ]), [], context)) chunks.push(chunk)
    }, (error: unknown) => {
      assert(error instanceof Error)
      assert(!error.message.includes('private fixture details'))
      if (terminal.type === 'response.failed') assert(error instanceof ProviderError && error.code === 'QUOTA')
      return true
    })
    assert.equal(chunks.at(-1)?.type, 'block-end')
    assert(!chunks.some(chunk => chunk.type === 'finish'))
  }
  await assert.rejects(collect(sse([])), { code: 'SIWC_STREAM_INTERRUPTED' })
})

test('prepared call remains bound to its registration and catalog filters visibility', async () => {
  let connection: ProviderConnection = { id: 'first', accessToken: 'synthetic-first' }
  const dispatched: string[] = []
  const adapter = new ChatGPTSiwcAdapter({
    connection: async () => connection,
    authorize: async (_options, value) => { dispatched.push(value.id) },
    fetch: async (url, init) => {
      if (String(url).endsWith('/models')) return Response.json({ models: [
        { slug: context.model, display_name: 'Fixture', visibility: 'list' },
        { slug: 'hidden', display_name: 'Hidden', visibility: 'hide' },
      ] })
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-first')
      return sse([{ type: 'response.completed', response: { output: [
        { type: 'message', content: [{ type: 'output_text', text: 'ok' }] },
      ] } }])
    },
  })
  assert.equal((await adapter.listModels('chatgpt-siwc')).length, 1)
  const prepared = await adapter.prepareCall('chatgpt-siwc', context.model)
  assert.equal(prepared.model.systemPromptUpdate, 'in-history')
  connection = { id: 'second', accessToken: 'synthetic-second' }
  for await (const _chunk of prepared.stream(options())) { /* consume */ }
  assert.deepEqual(dispatched, ['first'])
})

test('cancellation releases an unfinished SSE reader', async () => {
  let cancelled = false
  const signal = new AbortController()
  const response = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true } }))
  const promise = (async () => {
    for await (const _chunk of parseStream(response, [], context, signal.signal)) { /* consume */ }
  })()
  signal.abort()
  await assert.rejects(promise, { name: 'AbortError' })
  assert.equal(cancelled, true)
})

test('tool argument disagreement and undeclared tools stop before successful finish', async () => {
  const known = toolIdentity('file.read')
  await assert.rejects(collect(sse([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: known.name, namespace: known.namespace } },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"path":"a"}' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: known.name, namespace: known.namespace, arguments: '{"path":"b"}' } },
  ])), { code: 'SIWC_INVALID_STREAM' })
  await assert.rejects(collect(sse([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_fixture', name: 'undeclared', namespace: 'dsh' } },
  ])), { code: 'SIWC_UNKNOWN_TOOL' })
})

test('image projection preserves request handle and DSH offload recovery path without reading offloaded bytes', async () => {
  const attachment: ImageBlock['attachment'] = {
    attachmentId: 'sha256:fixture-image' as ImageBlock['attachment']['attachmentId'],
    mediaType: 'image/png', bytes: 5, width: 4, height: 3, name: 'fixture.png',
  }
  let reads = 0
  const resolve = async () => { reads++; return 'data:image/png;base64,AA==' }
  const access = { readonlyPath: '/workspace/attachments/fixture.png' }
  const request = await buildRequest(options({ messages: [{ role: 'user', content: [
    { type: 'image', attachment }, { type: 'image', attachment, offloaded: true },
  ] }] }), context, resolve, () => access)
  const input = request.body.input as { content: Record<string, unknown>[] }[]
  assert.deepEqual(input[0].content, [
    { type: 'input_text', text: requestImageHandleText(attachment, attachment, access) },
    { type: 'input_image', image_url: 'data:image/png;base64,AA==' },
    { type: 'input_text', text: offloadedImageText(attachment, access) },
  ])
  assert.equal(reads, 1)
  const pathUnavailable = await buildRequest(options({ messages: [{ role: 'user', content: [
    { type: 'image', attachment, offloaded: true },
  ] }] }), context)
  assert.deepEqual((pathUnavailable.body.input as { content: unknown[] }[])[0].content,
    [{ type: 'input_text', text: offloadedImageText(attachment) }])
})

test('completed output materializes tools even when output_item.done events are absent', async () => {
  const identity = toolIdentity('file.read')
  const tool = { type: 'function_call', id: 'fc_final', call_id: 'call_final', namespace: identity.namespace, name: identity.name, arguments: '{"path":"a"}' }
  const text = { type: 'message', id: 'msg_final', role: 'assistant', content: [{ type: 'output_text', text: '继续' }] }
  const chunks = await collect(sse([
    { type: 'response.output_item.added', output_index: 0, item: { ...text, content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: '继续' },
    { type: 'response.completed', response: { output: [text, tool] } },
  ]))
  const closed = chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
  assert.deepEqual(closed, [
    { type: 'text', text: '继续' },
    { type: 'tool-call', id: 'call_final', name: 'file.read', arguments: '{"path":"a"}' },
  ])
  const finish = chunks.at(-1)
  assert.equal(finish?.type === 'finish' && finish.reason.kind, 'tool-calls')
  assert.equal(finish?.type === 'finish' && finish.replayState?.blocks?.length, 2)
})

test('DSH assembler retains empty encrypted reasoning and replay follows retained blocks', async () => {
  const encrypted = { type: 'reasoning', id: 'rs_empty', encrypted_content: 'synthetic-empty-summary', summary: [] }
  const text = { type: 'message', id: 'msg_after_reasoning', role: 'assistant', content: [{ type: 'output_text', text: '回答' }] }
  const assembler = new BlockAssembler()
  for (const chunk of await collect(sse([{ type: 'response.completed', response: { output: [encrypted, text] } }]))) {
    assembler.push(chunk)
  }
  assert.deepEqual(assembler.blocks(), [{ type: 'reasoning', text: '' }, { type: 'text', text: '回答' }])
  const persisted = JSON.parse(JSON.stringify(assembler.message({
    provider: 'chatgpt-siwc', model: context.model, replayState: assembler.replayState,
  }))) as ReturnType<BlockAssembler['message']>
  const request = await buildRequest(options({ messages: [persisted] }), context)
  assert.deepEqual((request.body.input as object[])[0], encrypted)
  const compacted = createAssistantMessage({
    content: persisted.content.slice(1),
    source: { provider: 'chatgpt-siwc', model: context.model, replayState: {
      response: assembler.replayState?.response,
      blocks: assembler.replayState?.blocks?.slice(1),
    } },
  })
  const afterCompaction = await buildRequest(options({ messages: [compacted] }), context)
  assert.equal((afterCompaction.body.input as object[]).length, 1)
  assert(!JSON.stringify(afterCompaction.body).includes('synthetic-empty-summary'))
})

test('streamed reasoning summary and empty message preserve display blocks and exact native output replay', async () => {
  const reasoningFinal = {
    type: 'reasoning', id: 'rs_mismatch', encrypted_content: 'synthetic-encrypted',
    summary: [{ type: 'summary_text', text: '第一段摘要\n第二段摘要' }],
  }
  const emptyMsg = { type: 'message', id: 'msg_empty', role: 'assistant', status: 'completed', content: [] }
  const answer = { type: 'message', id: 'msg_answer', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '完成' }] }
  const assembler = new BlockAssembler()
  for (const chunk of await collect(sse([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_mismatch', summary: [] } },
    { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: '流式摘要' },
    { type: 'response.output_item.done', output_index: 0, item: reasoningFinal },
    { type: 'response.output_item.added', output_index: 1, item: emptyMsg },
    { type: 'response.output_item.done', output_index: 1, item: emptyMsg },
    { type: 'response.output_item.added', output_index: 2, item: { ...answer, content: [] } },
    { type: 'response.output_text.delta', output_index: 2, content_index: 0, delta: '完成' },
    { type: 'response.output_item.done', output_index: 2, item: answer },
    { type: 'response.completed', response: { id: 'resp_mismatch', status: 'completed', output: [reasoningFinal, emptyMsg, answer] } },
  ]))) {
    assembler.push(chunk)
  }
  assert.deepEqual(assembler.blocks(), [{ type: 'reasoning', text: '流式摘要' }, { type: 'text', text: '完成' }])
  const message = assembler.message({ provider: 'chatgpt-siwc', model: context.model, replayState: assembler.replayState })
  const replayed = await buildRequest(options({ messages: [message] }), context)
  assert.deepEqual(replayed.body.input, [reasoningFinal, emptyMsg, answer])
})

test('empty deltas and empty-summary reasoning do not create pre-completion blocks while completed responses retain encrypted reasoning', async () => {
  const encrypted = { type: 'reasoning', id: 'rs_empty_done', encrypted_content: 'synthetic-encrypted-done', summary: [] }
  const emptyMsg = { type: 'message', id: 'msg_empty_done', role: 'assistant', content: [] }
  const answer = { type: 'message', id: 'msg_answer_done', role: 'assistant', content: [{ type: 'output_text', text: '回答' }] }
  const preOutputEvents = [
    { type: 'response.created', response: { id: 'resp_pre', status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_empty_done', summary: [] } },
    { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: '' },
    { type: 'response.output_item.done', output_index: 0, item: encrypted },
    { type: 'response.output_item.added', output_index: 1, item: emptyMsg },
    { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: '' },
    { type: 'response.output_item.done', output_index: 1, item: emptyMsg },
  ]
  const interruptedChunks: StreamChunk[] = []
  await assert.rejects(async () => {
    for await (const chunk of parseStream(sse(preOutputEvents), [], context)) interruptedChunks.push(chunk)
  }, { code: 'SIWC_STREAM_INTERRUPTED' })
  assert.deepEqual(interruptedChunks, [])

  const assembler = new BlockAssembler()
  for (const chunk of await collect(sse([
    ...preOutputEvents,
    { type: 'response.output_item.added', output_index: 2, item: { ...answer, content: [] } },
    { type: 'response.output_text.delta', output_index: 2, content_index: 0, delta: '回答' },
    { type: 'response.output_item.done', output_index: 2, item: answer },
    { type: 'response.completed', response: { id: 'resp_done_ok', status: 'completed', output: [encrypted, emptyMsg, answer] } },
  ]))) {
    assembler.push(chunk)
  }
  assert.deepEqual(assembler.blocks(), [{ type: 'reasoning', text: '' }, { type: 'text', text: '回答' }])
  const message = assembler.message({ provider: 'chatgpt-siwc', model: context.model, replayState: assembler.replayState })
  const replayed = await buildRequest(options({ messages: [message] }), context)
  assert.deepEqual(replayed.body.input, [encrypted, emptyMsg, answer])
})

test('DSH auto-review request preserves review instructions with server-managed sampling', async () => {
  const policy = 'Classify the tool risk and return a JSON decision.'
  const review = options({system: policy, temperature: 0,
    messages: [{role: 'user', content: [{type: 'text', text: 'Review create_goal for the requested task.'}]}]})
  const result = await buildRequest(review, context)
  assert.equal(result.body.instructions, policy)
  assert.equal('temperature' in result.body, false)
  assert.deepEqual(result.body.input, [{role: 'user', content: [{type: 'input_text', text: 'Review create_goal for the requested task.'}]}])
  assert.equal(review.temperature, 0)
  await assert.rejects(buildRequest(options({temperature: 0.5}), context), {code: 'SIWC_UNSUPPORTED_PARAMETER'})
})

test('prepared call picks up renewed token in same activeGeneration, rejects changed epoch/generation, and deduplicates terminal usage', async () => {
  let current: ProviderConnection = {
    id: 'acct-1:1', accountId: 'acct-1', grantEpoch: 1, activeGeneration: 1, credentialGeneration: 1,
    replayScope: 'scope-1', accessToken: 'synthetic-token-v1',
  }
  const seenAuth: string[] = []
  const usages: number[] = []
  const bodies: Record<string, unknown>[] = []
  let callIndex = 0
  const adapter = new ChatGPTSiwcAdapter({
    connection: async () => current,
    authorize: async () => {},
    onUsage: usage => { usages.push(usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)) },
    enhancements: () => ({ cacheOptions: { mode: 'implicit', ttl: '30m' } }),
    fetch: async (url, init) => {
      if (String(url).endsWith('/models')) {
        return Response.json({ models: [{ slug: context.model, display_name: 'Fixture', visibility: 'list' }] })
      }
      seenAuth.push(new Headers(init?.headers).get('authorization') ?? '')
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      callIndex++
      if (callIndex === 1) {
        return sse([{
          type: 'response.completed',
          response: {
            id: 'resp-ok-1',
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
            usage: { input_tokens: 50, output_tokens: 5, input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 } },
          },
        }])
      }
      return sse([
        {
          type: 'response.failed',
          response: {
            id: 'resp-fail-1',
            usage: { input_tokens: 30, output_tokens: 2, input_tokens_details: { cached_tokens: 10 } },
            error: { code: 'unknown_parameter', param: 'prompt_cache_options', message: 'unsupported' },
          },
        },
        {
          type: 'error',
          response: {
            id: 'resp-fail-1',
            usage: { input_tokens: 30, output_tokens: 2, input_tokens_details: { cached_tokens: 10 } },
          },
          error: { code: 'unknown_parameter', param: 'prompt_cache_options', message: 'unsupported' },
        },
      ])
    },
  })

  const prepared = await adapter.prepareCall('chatgpt-siwc', context.model)
  current = { ...current, credentialGeneration: 2, accessToken: 'synthetic-token-v2' }
  for await (const _chunk of prepared.stream(options())) { /* consume */ }
  assert.deepEqual(seenAuth, ['Bearer synthetic-token-v2'])
  assert.deepEqual(usages, [50])
  assert.deepEqual(bodies[0].prompt_cache_options, { mode: 'implicit', ttl: '30m' })

  await assert.rejects(async () => {
    for await (const _chunk of prepared.stream(options())) { /* consume */ }
  })
  assert.deepEqual(usages, [50, 30])
  assert.equal(adapter.capabilities.status('scope-1', context.model, 'prompt_cache_options'), 'unsupported')

  current = { ...current, id: 'acct-1:2', activeGeneration: 2 }
  await assert.rejects(async () => {
    for await (const _chunk of prepared.stream(options())) { /* consume */ }
  }, { code: 'SIWC_CONNECTION_CHANGED' })
})

test('streamConnection records reasoningEffort in replayState and retries once when an enhanced capability is unsupported', async () => {
  const connection: ProviderConnection = {
    id: 'acct-fallback:1', accountId: 'acct-fallback', grantEpoch: 1, activeGeneration: 1, credentialGeneration: 1,
    replayScope: 'scope-fallback', accessToken: 'synthetic-token',
  }
  const bodies: Record<string, unknown>[] = []
  const persisted: { capability: string; status: string }[] = []
  let attempt = 0
  const adapter = new ChatGPTSiwcAdapter({
    connection: async () => connection,
    authorize: async () => {},
    enhancements: () => ({
      cacheOptions: { mode: 'implicit', ttl: '30m' },
      configurationUpdate: true,
      initialReasoningEffort: 'low',
      toolUpdate: 'addition-only',
    }),
    onCapability: (_model, capability, status) => {
      persisted.push({ capability, status })
    },
    fetch: async (url, init) => {
      if (String(url).endsWith('/models')) {
        return Response.json({
          models: [{
            slug: context.model,
            display_name: 'Fixture',
            visibility: 'list',
            supported_reasoning_levels: [{ effort: 'high' }],
          }],
        })
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      bodies.push(body)
      attempt++
      if (attempt === 1) {
        return sse([{
          type: 'response.failed',
          response: {
            id: 'resp-unsupported-1',
            error: { code: 'unknown_parameter', param: 'prompt_cache_options', message: 'Unknown parameter: prompt_cache_options' },
          },
        }])
      }
      return sse([{
        type: 'response.completed',
        response: {
          id: 'resp-retry-ok',
          output: [{ type: 'message', id: 'msg-retry-ok', role: 'assistant', content: [{ type: 'output_text', text: 'Recovered' }] }],
          usage: { input_tokens: 20, output_tokens: 5 },
        },
      }])
    },
  })

  const assembler = new BlockAssembler()
  const call = await adapter.prepareCall('chatgpt-siwc', context.model)
  for await (const chunk of call.stream(options({
    reasoningEffort: ReasoningEffortId('high'),
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Test fallback' }] }],
  }))) {
    assembler.push(chunk)
  }

  assert.equal(bodies.length, 2)
  assert.deepEqual(bodies[0].prompt_cache_options, { mode: 'implicit', ttl: '30m' })
  assert.equal('prompt_cache_options' in bodies[1], false)
  assert.deepEqual(assembler.blocks(), [{ type: 'text', text: 'Recovered' }])
  assert.equal((assembler.replayState?.response as { reasoningEffort?: string } | undefined)?.reasoningEffort, 'high')
  assert.deepEqual(persisted, [
    { capability: 'prompt_cache_options', status: 'unsupported' },
    { capability: 'configuration_update', status: 'supported' },
  ])
  assert.ok((bodies[1].input as Record<string, unknown>[]).some(item => item.type === 'configuration_update'))
  assert.equal(adapter.capabilities.status('scope-fallback', context.model, 'additional_tools'), 'unknown')
  assert.equal((await adapter.resolveModel('chatgpt-siwc', context.model)).toolUpdate, undefined)
  adapter.dispose()
})

test('ordinary image and tool HTTP 400 errors leave enhancement capability state unchanged', async () => {
  const attachment: ImageBlock['attachment'] = {
    attachmentId: 'sha256:capability-image' as ImageBlock['attachment']['attachmentId'],
    mediaType: 'image/png', bytes: 1, width: 1, height: 1, name: 'fixture.png',
  }
  for (const failure of [
    {code: 'invalid_value', param: 'input[0].content[1].image_url'},
    {code: 'unsupported_value', param: 'input[0].content[1].image_url'},
    {code: 'unsupported_parameter', param: 'tools[0].parameters'},
    {code: 'unknown_parameter', param: 'input'},
  ]) {
    const persisted: string[] = []
    const bodies: Record<string, unknown>[] = []
    const adapter = new ChatGPTSiwcAdapter({
      connection: async () => ({id: 'ordinary-validation', replayScope: 'ordinary-validation', accessToken: ''}),
      authorize: async () => {},
      image: async () => 'data:image/png;base64,AA==',
      enhancements: {
        cacheOptions: {mode: 'implicit', ttl: '30m'},
        configurationUpdate: true, initialReasoningEffort: 'low', toolUpdate: 'addition-only',
      },
      onCapability: (_model, capability, status) => { persisted.push(`${capability}:${status}`) },
      fetch: async (url, init) => {
        if (String(url).endsWith('/models')) return Response.json({models: [{
          slug: context.model, display_name: 'Fixture', visibility: 'list', input_modalities: ['text', 'image'],
          supported_reasoning_levels: ['low', 'high'],
        }]})
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return Response.json({error: failure}, {status: 400})
      },
    })
    try {
      await assert.rejects(async () => {
        for await (const _chunk of adapter.stream(options({
          reasoningEffort: ReasoningEffortId('high'), tools: toolSchemas,
          messages: [{role: 'user', content: [{type: 'image', attachment}]}],
        }))) {}
      }, (error: unknown) => error instanceof ProviderError && error.param === failure.param)
      assert.equal(bodies.length, 1)
      assert.ok(bodies[0].prompt_cache_options)
      assert.ok((bodies[0].input as Record<string, unknown>[]).some(item => item.type === 'configuration_update'))
      assert.deepEqual(persisted, [])
      for (const capability of ['prompt_cache_options', 'configuration_update', 'additional_tools'] as const) {
        assert.equal(adapter.capabilities.status('ordinary-validation', context.model, capability), 'unknown')
      }
    } finally { adapter.dispose() }
  }
})

test('each exact unsupported capability is removed individually while fallback shares the two-send budget', async () => {
  const bodies: Record<string, unknown>[] = []
  const persisted: string[] = []
  const adapter = new ChatGPTSiwcAdapter({
    connection: async () => ({id: 'budget-probe', replayScope: 'budget-probe', accessToken: ''}),
    authorize: async () => {},
    enhancements: {
      cacheOptions: {mode: 'implicit', ttl: '30m'},
      configurationUpdate: true, initialReasoningEffort: 'low',
    },
    onCapability: (_model, capability, status) => { persisted.push(`${capability}:${status}`) },
    fetch: async (url, init) => {
      if (String(url).endsWith('/models')) return Response.json({models: [{
        slug: context.model, display_name: 'Fixture', visibility: 'list', supported_reasoning_levels: ['low', 'high'],
      }]})
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return Response.json({error: bodies.length === 1
        ? {code: 'unknown_parameter', param: 'prompt_cache_options'}
        : {code: 'unsupported_value', param: 'input[1].type'}}, {status: 400})
    },
  })
  try {
    await assert.rejects(async () => {
      for await (const _chunk of adapter.stream(options({
        reasoningEffort: ReasoningEffortId('high'), messages: [{role: 'user', content: [{type: 'text', text: 'fixture'}]}],
      }))) {}
    }, (error: unknown) => error instanceof ProviderError && error.param === 'input[1].type')
    assert.equal(bodies.length, 2)
    assert.ok(bodies[0].prompt_cache_options)
    assert.equal('prompt_cache_options' in bodies[1], false)
    assert.ok((bodies[1].input as Record<string, unknown>[]).some(item => item.type === 'configuration_update'))
    assert.deepEqual(persisted, ['prompt_cache_options:unsupported', 'configuration_update:unsupported'])
  } finally { adapter.dispose() }
})

test('capability evidence follows actual WebSocket incremental input indices and skips unused settings', async () => {
  const server = new WebSocketServer({port: 0, host: '127.0.0.1'})
  try { await once(server, 'listening') }
  catch (error) { server.close(); throw error }
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture listener did not start')
  const bodies: Record<string, unknown>[] = []
  const persisted: string[] = []
  server.on('connection', socket => socket.on('message', raw => {
    const body = JSON.parse(raw.toString()) as Record<string, unknown>
    bodies.push(body)
    socket.send(JSON.stringify(bodies.length === 2
      ? {type: 'error', error: {code: 'unsupported_value', param: 'input[0].type'}}
      : {type: 'response.completed', response: {id: `wire-response-${bodies.length}`, status: 'completed',
          output: [{type: 'message', id: `msg-${bodies.length}`, role: 'assistant', content: [{type: 'output_text', text: 'OK'}]}]}}))
  }))
  const adapter = new ChatGPTSiwcAdapter({
    connection: async () => ({id: 'incremental-probe', replayScope: 'incremental-probe', accessToken: ''}),
    authorize: async () => {},
    enhancements: {configurationUpdate: true, initialReasoningEffort: 'low', toolUpdate: 'addition-only'},
    confirmedResponses: async () => new Set(['wire-response-1']),
    onCapability: (_model, capability, status) => { persisted.push(`${capability}:${status}`) },
    socketFactory: async (headers, signal) => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}`, {headers})
      const abort = () => socket.terminate()
      signal?.addEventListener('abort', abort, {once: true})
      try { await once(socket, 'open'); return socket }
      finally { signal?.removeEventListener('abort', abort) }
    },
    fetch: async url => {
      if (String(url).endsWith('/models')) return Response.json({models: [{
        slug: context.model, display_name: 'Fixture', visibility: 'list', supported_reasoning_levels: ['low', 'high'],
      }]})
      throw new Error('Unexpected HTTP inference')
    },
  })
  try {
    const common = options({
      sessionId: 'capability-probe-session' as GenerateOptions['sessionId'],
      messages: [{role: 'user', content: [{type: 'text', text: 'fixture'}]}],
    })
    const first = new BlockAssembler()
    for await (const chunk of adapter.stream({...common, reasoningEffort: ReasoningEffortId('low')})) first.push(chunk)
    const assistant = first.message({provider: 'chatgpt-siwc', model: context.model, replayState: first.replayState})
    assert.deepEqual(persisted, [])
    assert.equal(adapter.capabilities.status('incremental-probe', context.model, 'configuration_update'), 'unknown')
    assert.equal(adapter.capabilities.status('incremental-probe', context.model, 'additional_tools'), 'unknown')

    for await (const _chunk of adapter.stream({...common, messages: [...common.messages, assistant], reasoningEffort: ReasoningEffortId('high')})) {}
    assert.equal(bodies.length, 3)
    assert.equal(bodies[1].previous_response_id, 'wire-response-1')
    assert.deepEqual(bodies[1].input, [{type: 'configuration_update', reasoning: {effort: 'high'}}])
    assert.equal((bodies[2].input as Record<string, unknown>[]).some(item => item.type === 'configuration_update'), false)
    assert.deepEqual(persisted, ['configuration_update:unsupported'])
  } finally {
    adapter.dispose()
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

