import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BlockAssembler, createAssistantMessage, createDeveloperMessage, ReasoningEffortId, ToolCallId,
  type ContentBlock, type GenerateOptions, type ReplayEnvelope,
} from '@deepseek-ai/dsh-llm'
import { CapabilityRegistry, isUnsupportedParameterError, requestCapabilityProbes } from '../src/provider/capabilities.js'
import { ProviderError } from '../src/provider/errors.js'
import { buildRequest } from '../src/provider/request.js'
import { fingerprint, isEmptyMessage, replayEnvelope, type ReplayBlock, type ReplayContext, type WireItem } from '../src/provider/replay.js'
import { parseEvents } from '../src/provider/stream.js'
import { projectTools, resolveTool, toolIdentity } from '../src/provider/tools.js'

const context = { connectionId: 'fixture-account-generation', model: 'fixture-model' }
const textItem = {
  type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', phase: 'final_answer',
  content: [
    { type: 'output_text', text: '第一段', annotations: [{ type: 'url_citation', url: 'https://example.invalid/source', title: '资料', start_index: 0, end_index: 2 }] },
    { type: 'output_text', text: '第二段', annotations: [] },
  ],
}
const texts: ContentBlock[] = [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }]
function options(messages: GenerateOptions['messages'] = []): GenerateOptions {
  return { provider: 'chatgpt-siwc', model: context.model, messages }
}
function assistant(content = texts, metadata?: ReplayBlock[], version: 1 | 2 = 2) {
  const entries = metadata ?? content.map(block => ({ fingerprint: fingerprint(block), item: textItem, outputIndex: 0 }))
  const replayState = version === 2 ? replayEnvelope(context, entries)
    : { response: { version: 1, ...context }, blocks: entries }
  return createAssistantMessage({ source: { provider: 'chatgpt-siwc', model: context.model, replayState }, content })
}
async function input(message: ReturnType<typeof assistant>, selected: ReplayContext = context): Promise<WireItem[]> {
  const result = await buildRequest(options([message]), selected)
  return result.body.input as WireItem[]
}

test('complete native message preserves ID, phase, annotations and content grouping through JSON persistence', async () => {
  const message = JSON.parse(JSON.stringify(assistant()))
  assert.deepEqual(await input(message), [textItem])
})

test('removing one block from a native message projects only the retained text', async () => {
  const original = assistant()
  const metadata = original.source.replayState as ReplayEnvelope
  const reduced = createAssistantMessage({ source: { provider: original.source.provider, model: original.source.model, replayState: {
    ...metadata, blocks: metadata.blocks!.slice(1),
  } }, content: texts.slice(1) })
  const projected = await input(reduced)
  assert.deepEqual(projected, [{ role: 'assistant', phase: 'final_answer',
    content: [{ type: 'output_text', text: '第二段', annotations: [] }] }])
})

test('editing a block drops the complete native item and never restores old text or annotations', async () => {
  const original = assistant()
  const edited = createAssistantMessage({ source: { provider: original.source.provider, model: original.source.model, replayState: original.source.replayState },
    content: [texts[0], { type: 'text', text: '修订内容' }] })
  const projected = await input(edited)
  assert.deepEqual(projected.map(item => (item.content as WireItem[])[0].text), ['第一段', '修订内容'])
  assert.ok(projected.every(item => item.id === undefined))
  assert.ok(projected.every(item => ((item.content as WireItem[])[0].annotations as unknown[]).length === 0))
})

test('legacy v1 native groups remain reusable when complete and downgrade when reduced', async () => {
  const original = assistant(texts, texts.map(block => ({ fingerprint: fingerprint(block), item: textItem })), 1)
  assert.deepEqual(await input(original), [textItem])
  const reduced = createAssistantMessage({ source: { provider: original.source.provider, model: original.source.model, replayState: {
    ...(original.source.replayState as ReplayEnvelope), blocks: (original.source.replayState as ReplayEnvelope).blocks!.slice(0, 1),
  } }, content: texts.slice(0, 1) })
  assert.deepEqual((await input(reduced)).map(item => (item.content as WireItem[])[0].text), ['第一段'])
})

test('native output order follows response indices even when stream block discovery interleaves items', async () => {
  const identity = toolIdentity('fixture.read')
  const tool = { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture',
    namespace: identity.namespace, name: identity.name, arguments: '{"path":"fixture"}' }
  const call: ContentBlock = { type: 'tool-call', id: ToolCallId('call_fixture'), name: identity.original, arguments: tool.arguments }
  const reasoning = { type: 'reasoning', id: 'rs_fixture', summary: [], encrypted_content: 'synthetic-encrypted' }
  const reasoningBlock: ContentBlock = { type: 'reasoning', text: '' }
  const blocks = [call, texts[0], reasoningBlock, texts[1]]
  const metadata: ReplayBlock[] = [
    { fingerprint: fingerprint(call), item: tool, tool: identity, outputIndex: 2 },
    { fingerprint: fingerprint(texts[0]), item: textItem, outputIndex: 1 },
    { fingerprint: fingerprint(reasoningBlock), item: reasoning, outputIndex: 0 },
    { fingerprint: fingerprint(texts[1]), item: textItem, outputIndex: 1 },
  ]
  assert.deepEqual(await input(assistant(blocks, metadata)), [reasoning, textItem, tool])
})

test('another model or connection uses visible history without replaying opaque native state', async () => {
  const original = assistant()
  for (const selected of [{ ...context, model: 'other-model' }, { ...context, connectionId: 'other-account' }]) {
    const projected = await input(original, selected)
    assert.equal(projected.length, 2)
    assert.ok(projected.every(item => item.id === undefined))
  }
})

test('complete fingerprints cannot authorize a native message containing additional removed content', async () => {
  const metadata = texts.map(block => ({ fingerprint: fingerprint(block), item: { ...textItem,
    content: [...textItem.content, { type: 'output_text', text: '不应恢复', annotations: [] }],
  }, outputIndex: 0 }))
  const projected = await input(assistant(texts, metadata))
  assert.equal(projected.length, 2)
  assert.equal(JSON.stringify(projected).includes('不应恢复'), false)
})

test('tool definitions and object key order are deterministic while schema array order and inputs stay intact', () => {
  const first = { name: 'zeta', description: 'Z', parameters: { required: ['b', 'a'], properties: {
    b: { enum: ['b', 'a'], type: 'string' }, a: { type: 'number' },
  }, type: 'object' } }
  const second = { name: 'alpha', description: 'A', parameters: { type: 'object', properties: {} } }
  const before = JSON.stringify([first, second])
  const left = projectTools([first, second])
  const right = projectTools([second, { ...first, parameters: { type: 'object', properties: {
    a: { type: 'number' }, b: { type: 'string', enum: ['b', 'a'] },
  }, required: ['b', 'a'] } }])
  assert.equal(JSON.stringify(left.tools), JSON.stringify(right.tools))
  assert.deepEqual(left.identities.map(item => item.original), ['alpha', 'zeta'])
  assert.equal(JSON.stringify([first, second]), before)
  const definitions = left.tools[0].tools
  assert.deepEqual((definitions[1].parameters as { required: string[] }).required, ['b', 'a'])
  assert.deepEqual(projectTools([first]).identities, [toolIdentity('zeta')])
  assert.deepEqual(projectTools([]).tools, [])
})

test('v2 replay reuses intact native items across sessions and purposes while preserving response session identity', async () => {
  const selected = { ...context, sessionId: 'fixture-session-a' }
  const entries = texts.map(block => ({ fingerprint: fingerprint(block), item: textItem, outputIndex: 0 }))
  const envelope = replayEnvelope(selected, entries, 'resp_fixture')
  assert.equal((envelope.response as { responseId: string }).responseId, 'resp_fixture')
  assert.equal((envelope.response as { sessionId: string }).sessionId, 'fixture-session-a')
  const message = createAssistantMessage({ source: { provider: 'chatgpt-siwc', model: context.model, replayState: envelope }, content: texts })
  assert.deepEqual(await input(message, selected), [textItem])
  assert.deepEqual(await input(message, { ...selected, sessionId: 'fixture-session-b' }), [textItem])
  const legacy = assistant(texts, entries, 1)
  assert.deepEqual(await input(legacy, selected), [textItem])
})

test('empty native messages replay with intact response groups and drop when associated blocks change or shrink', async () => {
  const reasoning = { type: 'reasoning', id: 'rs_group', summary: [{ type: 'summary_text', text: '最终摘要' }], encrypted_content: 'enc_group' }
  const emptyMessage = { type: 'message', id: 'msg_empty', role: 'assistant', status: 'completed', content: [] }
  const reasoningBlock: ContentBlock = { type: 'reasoning', text: '流式展示摘要' }
  const blocks: ContentBlock[] = [reasoningBlock, ...texts]
  const entries: ReplayBlock[] = [
    { fingerprint: fingerprint(reasoningBlock), item: reasoning, outputIndex: 0 },
    { fingerprint: fingerprint(texts[0]), item: textItem, outputIndex: 2 },
    { fingerprint: fingerprint(texts[1]), item: textItem, outputIndex: 2 },
  ]
  const envelope = replayEnvelope(context, entries, 'resp_group', [{ outputIndex: 1, item: emptyMessage }])
  const full = createAssistantMessage({ source: { provider: 'chatgpt-siwc', model: context.model, replayState: envelope }, content: blocks })
  assert.deepEqual(await input(full), [reasoning, emptyMessage, textItem])

  const compacted = createAssistantMessage({
    source: { provider: 'chatgpt-siwc', model: context.model, replayState: { ...envelope, blocks: envelope.blocks!.slice(1) } },
    content: texts,
  })
  assert.deepEqual(await input(compacted), [textItem])

  const editedReasoning = createAssistantMessage({
    source: { provider: 'chatgpt-siwc', model: context.model, replayState: envelope },
    content: [{ type: 'reasoning', text: '被修改的摘要' }, ...texts],
  })
  assert.deepEqual(await input(editedReasoning), [textItem])
})

test('v3 replayScope survives A->B->A account switching and supports v2 legacyConnectionId migration', async () => {
  const entries = texts.map((block, partIndex) => ({ fingerprint: fingerprint(block), item: textItem, outputIndex: 0, partIndex }))
  const scopeA = 'scope-account-a-epoch-1'
  const envelopeV3 = replayEnvelope({ connectionId: 'acct-a:1', replayScope: scopeA, model: context.model, wireSessionId: 'wire-a' }, entries, 'resp_v3')
  const responseV3 = envelopeV3.response as Record<string, unknown>
  assert.equal(responseV3.version, 3)
  assert.equal(responseV3.projectionVersion, 1)
  assert.equal(responseV3.replayScope, scopeA)
  assert.equal(Array.isArray(responseV3.nativeItems), true)

  const messageV3 = createAssistantMessage({ source: { provider: 'chatgpt-siwc', model: context.model, replayState: envelopeV3 }, content: texts })
  // Switch A:1 -> B:2 -> A:3 (same replayScope, new connectionId)
  const afterReturnToA = await buildRequest(options([messageV3]), { connectionId: 'acct-a:3', replayScope: scopeA, model: context.model })
  assert.deepEqual(afterReturnToA.body.input, [textItem])
  assert.deepEqual(afterReturnToA.replayStats, { totalBlocks: 2, nativeBlocks: 2, degradedBlocks: 0, reasons: ['intact'] })

  // Switch to account B or re-authorized epoch 2 degrades without leaking native item IDs
  const onAccountB = await buildRequest(options([messageV3]), { connectionId: 'acct-b:2', replayScope: 'scope-account-b-epoch-1', model: context.model })
  assert.equal((onAccountB.body.input as WireItem[]).every(item => item.id === undefined), true)
  assert.deepEqual(onAccountB.replayStats.reasons, ['scope-changed'])

  // Legacy v2 envelope with connectionId 'acct-a:1' matches when legacyConnectionId is provided
  const envelopeV2: ReplayEnvelope = {
    response: { version: 2, connectionId: 'acct-a:1', model: context.model },
    blocks: (envelopeV3.blocks as ReplayBlock[]).map(({ visiblePartIndices: _v, ...rest }) => rest),
  }
  const messageV2 = createAssistantMessage({ source: { provider: 'chatgpt-siwc', model: context.model, replayState: envelopeV2 }, content: texts })
  const migratedV2 = await buildRequest(options([messageV2]), {
    connectionId: 'acct-a:4', replayScope: scopeA, legacyConnectionId: 'acct-a:1', model: context.model,
  })
  assert.deepEqual(migratedV2.body.input, [textItem])
  const revokedV2 = await buildRequest(options([messageV2]), {
    connectionId: 'acct-a:4', replayScope: 'scope-account-a-epoch-2', model: context.model,
  })
  assert.equal((revokedV2.body.input as WireItem[]).every(item => item.id === undefined), true)
})

test('empty output_text and empty refusal parts replay in pure-empty and mixed-content native messages while whitespace remains visible', async () => {
  const emptyPartsMsg: WireItem = {
    type: 'message', id: 'msg_empty_parts', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: '' }, { type: 'refusal', refusal: '' }],
  }
  const mixedMsg: WireItem = {
    type: 'message', id: 'msg_mixed', role: 'assistant', status: 'completed', phase: 'final_answer',
    content: [
      { type: 'output_text', text: '' },
      { type: 'output_text', text: '正文内容', annotations: [{ type: 'url_citation', url: 'https://example.invalid/ref' }] },
      { type: 'refusal', refusal: '' },
    ],
  }
  assert.equal(isEmptyMessage(emptyPartsMsg), true)
  assert.equal(isEmptyMessage({ ...emptyPartsMsg, content: [{ type: 'output_text', text: ' ' }] }), false)
  assert.equal(isEmptyMessage({ ...emptyPartsMsg, content: [{ type: 'output_text', text: '\n' }] }), false)

  async function* events() {
    yield { type: 'response.completed', response: { id: 'resp_empty_parts', status: 'completed', output: [emptyPartsMsg, mixedMsg] } }
  }
  const assembler = new BlockAssembler()
  for await (const chunk of parseEvents(events(), [], context)) {
    assembler.push(chunk)
  }
  assert.deepEqual(assembler.blocks(), [{ type: 'text', text: '正文内容' }])
  const message = assembler.message({ provider: 'chatgpt-siwc', model: context.model, replayState: assembler.replayState })
  const replayed = await buildRequest(options([message]), context)
  assert.deepEqual(replayed.body.input, [emptyPartsMsg, mixedMsg])

  // Extra whitespace part not present in visible blocks must NOT be treated as empty
  const spaceInjected: WireItem = {
    ...mixedMsg,
    content: [{ type: 'output_text', text: ' ' }, { type: 'output_text', text: '正文内容', annotations: [] }],
  }
  const untrusted = assistant([{ type: 'text', text: '正文内容' }], [
    { fingerprint: fingerprint({ type: 'text', text: '正文内容' }), item: spaceInjected, outputIndex: 0, partIndex: 1 },
  ])
  const downgraded = await input(untrusted)
  assert.equal(downgraded.length, 1)
  assert.equal(downgraded[0].id, undefined)
})

test('partial degradation preserves response outputIndex/partIndex order unless user reorders blocks', async () => {
  const identity = toolIdentity('fixture.read')
  const tool = {
    type: 'function_call', id: 'fc_interleaved', call_id: 'call_interleaved',
    namespace: identity.namespace, name: identity.name, arguments: '{"path":"fixture"}',
  }
  const callBlock: ContentBlock = { type: 'tool-call', id: ToolCallId('call_interleaved'), name: identity.original, arguments: tool.arguments }
  const reasoning = { type: 'reasoning', id: 'rs_interleaved', summary: [], encrypted_content: 'enc_interleaved' }
  const reasoningBlock: ContentBlock = { type: 'reasoning', text: '' }
  const blocks: ContentBlock[] = [callBlock, texts[0], reasoningBlock, texts[1]]
  const metadata: ReplayBlock[] = [
    { fingerprint: fingerprint(callBlock), item: tool, tool: identity, outputIndex: 2, partIndex: 0 },
    { fingerprint: fingerprint(texts[0]), item: textItem, outputIndex: 1, partIndex: 0 },
    { fingerprint: fingerprint(reasoningBlock), item: reasoning, outputIndex: 0, partIndex: 0 },
    { fingerprint: fingerprint(texts[1]), item: textItem, outputIndex: 1, partIndex: 1 },
  ]
  const original = assistant(blocks, metadata)

  // Edit texts[1] in-place: textItem degrades into two ordered text items at outputIndex 1, while reasoning (0) and tool (2) stay native
  const edited = createAssistantMessage({
    source: { provider: original.source.provider, model: original.source.model, replayState: original.source.replayState },
    content: [callBlock, texts[0], reasoningBlock, { type: 'text', text: '第二段已修改' }],
  })
  const partialResult = await buildRequest(options([edited]), context)
  assert.deepEqual(partialResult.body.input, [
    reasoning,
    { role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '第一段', annotations: [] }] },
    { role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '第二段已修改', annotations: [] }] },
    tool,
  ])
  assert.deepEqual(partialResult.replayStats, {
    totalBlocks: 4,
    nativeBlocks: 2,
    degradedBlocks: 2,
    reasons: ['edited'],
  })

  // Editing a single tool-call block's tool name projects the updated tool name and namespace instead of stale slotMeta.tool
  const editedToolName = createAssistantMessage({
    source: { provider: original.source.provider, model: original.source.model, replayState: original.source.replayState },
    content: [{ ...callBlock, name: 'fixture.write' }, texts[0], reasoningBlock, texts[1]],
  })
  const editedToolResult = await buildRequest(options([editedToolName]), context)
  const expectedWriteIdentity = toolIdentity('fixture.write')
  assert.deepEqual(editedToolResult.body.input, [
    reasoning,
    textItem,
    {
      type: 'function_call',
      call_id: 'call_interleaved',
      name: expectedWriteIdentity.name,
      namespace: expectedWriteIdentity.namespace,
      arguments: tool.arguments,
    },
  ])

  // Editing and reordering two interleaved text blocks keeps DSH's current block order instead of sorting back to old partIndex
  const bothTextsEditedAndReordered = createAssistantMessage({
    source: { provider: original.source.provider, model: original.source.model, replayState: original.source.replayState },
    content: [callBlock, { type: 'text', text: 'A-已改并前置' }, reasoningBlock, { type: 'text', text: 'B-已改并后置' }],
  })
  const twoEditedResult = await buildRequest(options([bothTextsEditedAndReordered]), context)
  const twoEditedTexts = (twoEditedResult.body.input as WireItem[])
    .filter(item => item.role === 'assistant')
    .map(item => (item.content as WireItem[])[0].text)
  assert.deepEqual(twoEditedTexts, ['A-已改并前置', 'B-已改并后置'])

  // Also when two interleaved text items originally had reversed outputIndex (1 then 0), editing both keeps current DSH order
  const reversedInterleaved = assistant(
    [{ type: 'text', text: '原后置块' }, { type: 'text', text: '原前置块' }],
    [
      { fingerprint: fingerprint({ type: 'text', text: '原后置块' }), item: { ...textItem, id: 'msg_1', content: [{ type: 'output_text', text: '原后置块', annotations: [] }] }, outputIndex: 1, partIndex: 0 },
      { fingerprint: fingerprint({ type: 'text', text: '原前置块' }), item: { ...textItem, id: 'msg_0', content: [{ type: 'output_text', text: '原前置块', annotations: [] }] }, outputIndex: 0, partIndex: 0 },
    ],
  )
  const reversedBothEdited = createAssistantMessage({
    source: { provider: reversedInterleaved.source.provider, model: reversedInterleaved.source.model, replayState: reversedInterleaved.source.replayState },
    content: [{ type: 'text', text: 'A-edited' }, { type: 'text', text: 'B-edited' }],
  })
  const reversedEditedInput = await input(reversedBothEdited)
  assert.deepEqual(reversedEditedInput.map(item => (item.content as WireItem[])[0].text), ['A-edited', 'B-edited'])

  // Explicit user reordering of blocks keeps DSH's current block order and records 'reordered'
  const reordered = createAssistantMessage({
    source: { provider: original.source.provider, model: original.source.model, replayState: original.source.replayState },
    content: [texts[1], texts[0], callBlock, reasoningBlock],
  })
  const reorderedResult = await buildRequest(options([reordered]), context)
  const reorderedInput = reorderedResult.body.input as WireItem[]
  assert.equal((reorderedInput[0].content as WireItem[])[0].text, '第二段')
  assert.equal((reorderedInput[1].content as WireItem[])[0].text, '第一段')
  assert.equal(reorderedInput[2].type, 'function_call')
  assert.equal(reorderedResult.replayStats.reasons.includes('reordered'), true)
})

test('reordered or unanchored history never merges a native group across current blocks', async () => {
  const [a, b, c, d] = ['A', 'B', 'C', 'D'].map(text => ({ type: 'text' as const, text }))
  const nativeItem = (id: string, blocks: readonly { text: string }[]): WireItem => ({
    type: 'message', id, role: 'assistant', status: 'completed',
    content: blocks.map(block => ({ type: 'output_text', text: block.text, annotations: [] })),
  })
  const abItem = nativeItem('msg_group_ab', [a, b])
  const cItem = nativeItem('msg_group_c', [c])
  const dItem = nativeItem('msg_group_d', [d])
  const original = assistant([a, c, b, d], [
    { fingerprint: fingerprint(a), item: abItem, outputIndex: 0, partIndex: 0 },
    { fingerprint: fingerprint(c), item: cItem, outputIndex: 1, partIndex: 0 },
    { fingerprint: fingerprint(b), item: abItem, outputIndex: 0, partIndex: 1 },
    { fingerprint: fingerprint(d), item: dItem, outputIndex: 2, partIndex: 0 },
  ])

  // Normal stream discovery may interleave blocks; intact history still restores native wire order.
  const intact = await buildRequest(options([original]), context)
  assert.deepEqual(intact.body.input, [abItem, cItem, dItem])
  assert.deepEqual(intact.replayStats, { totalBlocks: 4, nativeBlocks: 4, degradedBlocks: 0, reasons: ['intact'] })

  // Only content changes. A/B remain at their old indices, so stale native grouping must not move B before D.
  const reordered = createAssistantMessage({
    source: { provider: original.source.provider, model: original.source.model, replayState: original.source.replayState },
    content: [a, d, b, c],
  })
  const reorderedResult = await buildRequest(options([reordered]), context)
  assert.deepEqual(reorderedResult.body.input, [a, d, b, c].map(block => ({
    role: 'assistant', content: [{ type: 'output_text', text: block.text, annotations: [] }],
  })))
  assert.deepEqual(reorderedResult.replayStats, { totalBlocks: 4, nativeBlocks: 0, degradedBlocks: 4, reasons: ['reordered'] })

  // Multiple edited slots also make old wire order untrustworthy, even without a detectable permutation.
  const editedContent = [a, { type: 'text' as const, text: 'C-edited' }, b, { type: 'text' as const, text: 'D-edited' }]
  const edited = createAssistantMessage({
    source: { provider: original.source.provider, model: original.source.model, replayState: original.source.replayState },
    content: editedContent,
  })
  const editedResult = await buildRequest(options([edited]), context)
  assert.deepEqual(editedResult.body.input, editedContent.map(block => ({
    role: 'assistant', content: [{ type: 'output_text', text: block.text, annotations: [] }],
  })))
  assert.deepEqual(editedResult.replayStats, { totalBlocks: 4, nativeBlocks: 0, degradedBlocks: 4, reasons: ['edited'] })
})

test('request views isolate comparison_response_id from semanticSettings and support tool/config additions and capability states', async () => {
  const alpha = { name: 'alpha', description: 'Alpha', parameters: { type: 'object', properties: {} } }
  const beta = { name: 'beta', description: 'Beta', parameters: { type: 'object', properties: { q: { type: 'string' } } } }
  const devMsg = createDeveloperMessage({
    source: { kind: 'user' },
    content: [{ type: 'tool-addition', toolName: 'beta' }],
  })
  const reqOptions: GenerateOptions = {
    provider: 'chatgpt-siwc',
    model: context.model,
    reasoningEffort: ReasoningEffortId('high'),
    tools: [alpha, beta],
    toolHistory: {
      tools: [alpha],
      updates: [{ messageId: devMsg.id, additions: [beta] }],
    },
    messages: [
      { role: 'user', content: [{ type: 'text', text: '初始问题' }] },
      devMsg,
      { role: 'user', content: [{ type: 'text', text: '继续执行' }] },
    ],
  }

  const first = await buildRequest(reqOptions, context, undefined, undefined, {
    cacheOptions: { mode: 'implicit', ttl: '30m', comparisonResponseId: 'resp_cmp_1', cacheKey: 'group-a', breakpointVersion: 1 },
    toolUpdate: 'addition-only',
    configurationUpdate: true,
    initialReasoningEffort: 'low',
  })
  const second = await buildRequest(reqOptions, context, undefined, undefined, {
    cacheOptions: { mode: 'implicit', ttl: '30m', comparisonResponseId: 'resp_cmp_2', cacheKey: 'group-a', breakpointVersion: 1 },
    toolUpdate: 'addition-only',
    configurationUpdate: true,
    initialReasoningEffort: 'low',
  })
  const ttlChanged = await buildRequest(reqOptions, context, undefined, undefined, {
    cacheOptions: { mode: 'implicit', ttl: '12h', comparisonResponseId: 'resp_cmp_2', cacheKey: 'group-a', breakpointVersion: 1 },
    toolUpdate: 'addition-only',
    configurationUpdate: true,
    initialReasoningEffort: 'low',
  })

  // Changing comparisonResponseId alone keeps semanticSettings and cachePolicy.policyHash identical
  assert.deepEqual(first.semanticSettings, second.semanticSettings)
  assert.equal(first.cachePolicy.policyHash, second.cachePolicy.policyHash)
  assert.notEqual(first.cachePolicy.policyHash, ttlChanged.cachePolicy.policyHash)
  assert.notDeepEqual(first.semanticSettings, ttlChanged.semanticSettings)
  assert.equal(first.body.prompt_cache_key, 'group-a')
  assert.deepEqual(first.body.prompt_cache_options, { mode: 'implicit', ttl: '30m', comparison_response_id: 'resp_cmp_1' })

  // Baseline body.tools contains only alpha, while identities resolves both alpha and beta, and input has additional_tools + reasoning configuration_update
  assert.deepEqual(first.body.tools, projectTools([alpha]).tools)
  assert.equal(resolveTool(first.identities, toolIdentity('beta').name, 'dsh').original, 'beta')
  assert.deepEqual(first.body.reasoning, { effort: 'low', summary: 'auto' })
  const projectedInput = first.body.input as WireItem[]
  assert.deepEqual(projectedInput[1], {
    type: 'additional_tools',
    role: 'developer',
    tools: projectTools([beta]).tools,
  })
  assert.deepEqual(projectedInput.at(-1), {
    type: 'configuration_update',
    reasoning: { effort: 'high' },
  })

  // Multi-turn reasoning effort configuration_update stays at the historical turn position across subsequent turns
  const turn1ReplyItem: WireItem = {
    type: 'message', id: 'msg_turn_1', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: '第一轮回复', annotations: [] }],
  }
  const turn1ReplyBlock: ContentBlock = { type: 'text', text: '第一轮回复' }
  const turn1Assistant = createAssistantMessage({
    source: {
      provider: 'chatgpt-siwc',
      model: context.model,
      replayState: replayEnvelope(
        { ...context, reasoningEffort: 'low' },
        [{ fingerprint: fingerprint(turn1ReplyBlock), item: turn1ReplyItem, outputIndex: 0, partIndex: 0 }],
        'resp_turn_1',
      ),
    },
    content: [turn1ReplyBlock],
  })
  const turn2ReplyItem: WireItem = {
    type: 'message', id: 'msg_turn_2', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: '第二轮高强度回复', annotations: [] }],
  }
  const turn2ReplyBlock: ContentBlock = { type: 'text', text: '第二轮高强度回复' }
  const turn2Assistant = createAssistantMessage({
    source: {
      provider: 'chatgpt-siwc',
      model: context.model,
      replayState: replayEnvelope(
        { ...context, reasoningEffort: 'high' },
        [{ fingerprint: fingerprint(turn2ReplyBlock), item: turn2ReplyItem, outputIndex: 0, partIndex: 0 }],
        'resp_turn_2',
      ),
    },
    content: [turn2ReplyBlock],
  })

  const turn2Req = await buildRequest({
    provider: 'chatgpt-siwc',
    model: context.model,
    reasoningEffort: ReasoningEffortId('high'),
    messages: [
      { role: 'user', content: [{ type: 'text', text: '第一问' }] },
      turn1Assistant,
      { role: 'user', content: [{ type: 'text', text: '第二问' }] },
    ],
  }, context, undefined, undefined, {
    configurationUpdate: true,
    initialReasoningEffort: 'low',
  })
  const turn2Input = turn2Req.body.input as WireItem[]
  assert.deepEqual(turn2Input.at(-1), { type: 'configuration_update', reasoning: { effort: 'high' } })

  const turn3Req = await buildRequest({
    provider: 'chatgpt-siwc',
    model: context.model,
    reasoningEffort: ReasoningEffortId('high'),
    messages: [
      { role: 'user', content: [{ type: 'text', text: '第一问' }] },
      turn1Assistant,
      { role: 'user', content: [{ type: 'text', text: '第二问' }] },
      turn2Assistant,
      { role: 'user', content: [{ type: 'text', text: '第三问' }] },
    ],
  }, context, undefined, undefined, {
    configurationUpdate: true,
    initialReasoningEffort: 'low',
  })
  const turn3Input = turn3Req.body.input as WireItem[]
  const expectedTurn2Transcript = [...turn2Input, turn2ReplyItem]
  assert.deepEqual(turn3Input.slice(0, expectedTurn2Transcript.length), expectedTurn2Transcript)
  assert.equal(turn3Input.filter(item => item.type === 'configuration_update').length, 1)

  // CapabilityRegistry state transitions and error classification
  const registry = new CapabilityRegistry()
  assert.equal(registry.selectProbeCandidate('scope-1', 'gpt-5'), 'prompt_cache_options')
  registry.record('scope-1', 'gpt-5', 'prompt_cache_options', 'supported', 1000)
  assert.equal(registry.isSupported('scope-1', 'gpt-5', 'prompt_cache_options'), true)
  assert.equal(registry.selectProbeCandidate('scope-1', 'gpt-5'), 'configuration_update')

  const probes = requestCapabilityProbes({
    prompt_cache_options: { mode: 'implicit' },
    input: [
      { role: 'user', content: [] },
      { type: 'configuration_update', reasoning: { effort: 'high' } },
    ],
  })
  const paramErr = new ProviderError('unknown_parameter', 'prompt_cache_options', 400)
  const quotaErr = new ProviderError('subscription_sharing_usage_limit_exceeded', undefined, 429)
  assert.equal(isUnsupportedParameterError(paramErr, 'prompt_cache_options', probes), true)
  assert.equal(isUnsupportedParameterError(paramErr, 'additional_tools', probes), false)
  assert.equal(isUnsupportedParameterError(quotaErr), false)
  assert.equal(registry.recordError('scope-1', 'gpt-5', 'configuration_update', new ProviderError('unsupported_value', 'input[1].type', 400)), false)
  assert.equal(registry.recordError('scope-1', 'gpt-5', 'configuration_update', new ProviderError('unsupported_value', 'input[1].type', 400), probes), true)
  assert.equal(registry.isAllowed('scope-1', 'gpt-5', 'configuration_update'), false)
  registry.invalidateScope('scope-1')
  assert.equal(registry.status('scope-1', 'gpt-5', 'prompt_cache_options'), 'unknown')
})
