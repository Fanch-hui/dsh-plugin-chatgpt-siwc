import { RequestDiagnostics } from '../src/diagnostics/requests.js'
import type { RequestDiagnostic } from '../src/diagnostics/types.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import WebSocket, { WebSocketServer } from 'ws'
import {
  BlockAssembler, ReasoningEffortId, createAssistantMessage,
  type GenerateOptions, type Message,
} from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionStore } from '@deepseek-ai/dsh-session'
import { ChatGPTSiwcAdapter, type ProviderConnection, type ProviderDependencies } from '../src/provider/adapter.js'
import { confirmedResponses } from '../src/provider/durability.js'
import type { SocketFactory } from '../src/provider/transport/index.js'

type Wire = Record<string, unknown>
const model = 'fixture-model'
const initial = { role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] }
const followup = { role: 'user' as const, content: [{ type: 'text' as const, text: 'continue' }] }
const connection: ProviderConnection = { id: 'fixture-registration:1', accessToken: 'synthetic-access' }
const options = (extra: Partial<GenerateOptions> = {}): GenerateOptions => ({
  provider: 'chatgpt-siwc', model, sessionId: SessionId('fixture-session'), messages: [initial], ...extra,
})
function output(id: string): Wire[] {
  return [{ type: 'message', id: `msg-${id}`, role: 'assistant', phase: 'final_answer',
    content: [{ type: 'output_text', text: 'OK', annotations: [] }] }]
}
function completed(id: string): Wire {
  return { type: 'response.completed', response: { id, status: 'completed', output: output(id),
    usage: { input_tokens: 12, output_tokens: 2, input_tokens_details: { cached_tokens: 4 } } } }
}
function sse(id: string): Response {
  return new Response(`data: ${JSON.stringify(completed(id))}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
}
function catalog(): Response {
  return Response.json({ models: [model, 'fixture-other-model'].map(slug => ({
    slug, display_name: slug, visibility: 'list', context_window: 32_000, max_context_window: 64_000,
    supported_reasoning_levels: ['low', 'high'], default_reasoning_level: 'low', input_modalities: ['text'],
  })) })
}
async function assembled(adapter: ChatGPTSiwcAdapter, request = options()) {
  const assembler = new BlockAssembler()
  for await (const chunk of adapter.stream(request)) assembler.push(chunk)
  assert.equal(assembler.finish.kind, 'stop')
  return JSON.parse(JSON.stringify(assembler.message({
    provider: 'chatgpt-siwc', model: request.model, replayState: assembler.replayState,
  }))) as ReturnType<BlockAssembler['message']>
}
async function fixture(handle?: (socket: WebSocket, message: Wire) => void) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture listener did not start')
  const headers: Record<string, unknown>[] = []
  const messages: Wire[] = []
  server.on('connection', (socket, request) => {
    headers.push(request.headers)
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString()) as Wire
      messages.push(message)
      if (handle) handle(socket, message)
      else socket.send(JSON.stringify(completed(`response-${messages.length}`)))
    })
  })
  const socketFactory: SocketFactory = async (headers, signal) => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}`, { headers })
    const abort = () => socket.terminate()
    signal?.addEventListener('abort', abort, { once: true })
    try { await once(socket, 'open'); return socket }
    finally { signal?.removeEventListener('abort', abort) }
  }
  return { headers, messages, socketFactory, async close() {
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>(resolve => server.close(() => resolve()))
  } }
}
function dependencies(extra: Partial<ProviderDependencies> = {}): ProviderDependencies {
  return {
    connection: async () => connection, authorize: async () => {}, sessionScope: '/fixture/profile-a',
    fetch: async input => {
      if (String(input).endsWith('/models')) return catalog()
      throw new Error('Unexpected HTTP inference')
    }, ...extra,
  }
}

test('adapter keeps request session identity across restart and token renewal and isolates each scope', async () => {
  const sent: { session: string | null; authorization: string | null }[] = []
  async function run(scope: string, session = 'fixture-session', selected = model, accessToken = 'synthetic-access') {
    const adapter = new ChatGPTSiwcAdapter(dependencies({
      sessionScope: scope, websocket: false, connection: async () => ({ ...connection, accessToken }),
      fetch: async (input, init) => {
        if (String(input).endsWith('/models')) return catalog()
        const headers = new Headers(init?.headers)
        sent.push({ session: headers.get('session-id'), authorization: headers.get('authorization') })
        return sse('http-response')
      },
    }))
    try { await assembled(adapter, options({ sessionId: SessionId(session), model: selected })) }
    finally { adapter.dispose() }
  }
  await run('/fixture/profile-a')
  await run('/fixture/profile-a', 'fixture-session', model, 'synthetic-rotated')
  await run('/fixture/profile-b')
  await run('/fixture/profile-a', 'fixture-other-session')
  await run('/fixture/profile-a', 'fixture-session', 'fixture-other-model')
  assert.match(sent[0].session!, /^[a-f0-9]{64}$/)
  assert.equal(sent[0].session, sent[1].session)
  assert.notEqual(sent[0].authorization, sent[1].authorization)
  assert.equal(new Set([sent[0].session, ...sent.slice(2).map(item => item.session)]).size, 4)
})

test('assembled and durably saved native output enables adapter WebSocket incremental continuation', async () => {
  const server = await fixture()
  let durable: Message[] = []
  let flushes = 0
  const storage = {
    get: () => ({ deriveMessages: () => durable }),
    flush: async () => { flushes++; return true },
  } as unknown as Pick<SessionStore, 'get' | 'flush'>
  const adapter = new ChatGPTSiwcAdapter(dependencies({ socketFactory: server.socketFactory,
    confirmedResponses: (request, context) => confirmedResponses(storage, request, context),
  }))
  try {
    const first = await assembled(adapter)
    assert.equal(flushes, 0)
    durable = [first]
    await assembled(adapter, options({ messages: [initial, first, followup] }))
    assert.equal(flushes, 1)
    assert.equal(server.headers.length, 1)
    assert.equal(server.messages[1].previous_response_id, 'response-1')
    assert.deepEqual(server.messages[1].input, [{ role: 'user', content: [{ type: 'input_text', text: 'continue' }] }])
    assert.equal('stream' in server.messages[1], false)
    assert.equal(server.messages[1].store, false)
    const replay = first.source.replayState as { response: { responseId: string } }
    assert.equal(replay.response.responseId, 'response-1')
  } finally { adapter.dispose(); await server.close() }
})

test('adapter sends full context until save confirmation and after historical content changes', async () => {
  for (const changed of [false, true]) {
    const server = await fixture()
    const adapter = new ChatGPTSiwcAdapter(dependencies({ socketFactory: server.socketFactory,
      confirmedResponses: async () => changed ? new Set(['response-1']) : new Set(),
    }))
    try {
      const first = await assembled(adapter)
      const history = changed ? createAssistantMessage({
        source: { provider: first.source.provider, model: first.source.model, replayState: first.source.replayState },
        content: [{ type: 'text', text: 'compacted answer' }],
      }) : first
      await assembled(adapter, options({ messages: [initial, history, followup] }))
      assert.equal('previous_response_id' in server.messages[1], false)
      assert.equal((server.messages[1].input as unknown[]).length, 3)
      if (changed) {
        assert(JSON.stringify(server.messages[1].input).includes('compacted answer'))
        assert(!JSON.stringify(server.messages[1].input).includes('msg-response-1'))
      }
    } finally { adapter.dispose(); await server.close() }
  }
})

test('HTTP token expiry renews once and retains the exact request and session identity', async () => {
  const attempts: { body: string; headers: Headers }[] = []
  const rejected: (string | undefined)[] = []
  const adapter = new ChatGPTSiwcAdapter(dependencies({ websocket: false,
    connection: async (_signal, old) => {
      rejected.push(old)
      return { ...connection, accessToken: old ? 'synthetic-renewed' : connection.accessToken }
    },
    fetch: async (input, init) => {
      if (String(input).endsWith('/models')) return catalog()
      attempts.push({ body: String(init?.body), headers: new Headers(init?.headers) })
      return attempts.length === 1
        ? Response.json({ error: { code: 'token_expired' } }, { status: 401 }) : sse('renewed-response')
    },
  }))
  try {
    await assembled(adapter)
    assert.equal(attempts.length, 2)
    assert.equal(attempts[0].body, attempts[1].body)
    assert.equal(attempts[0].headers.get('session-id'), attempts[1].headers.get('session-id'))
    assert.equal(attempts[1].headers.get('authorization'), 'Bearer synthetic-renewed')
    assert.deepEqual(rejected, [undefined, 'synthetic-access'])
  } finally { adapter.dispose() }
})

test('HTTP recovery rejects a different account and stops after a second token expiry', async () => {
  for (const changedAccount of [false, true]) {
    let requests = 0
    const adapter = new ChatGPTSiwcAdapter(dependencies({ websocket: false,
      connection: async (_signal, old) => old
        ? { ...connection, id: changedAccount ? 'other-registration:1' : connection.id, accessToken: 'synthetic-renewed' }
        : connection,
      fetch: async input => {
        if (String(input).endsWith('/models')) return catalog()
        requests++
        return Response.json({ error: { code: 'token_expired' } }, { status: 401 })
      },
    }))
    try {
      await assert.rejects(assembled(adapter), changedAccount
        ? { code: 'SIWC_CONNECTION_CHANGED' } : { providerCode: 'token_expired' })
      assert.equal(requests, changedAccount ? 1 : 2)
    } finally { adapter.dispose() }
  }
})

test('account model capabilities reach DSH resolution and reject an unlisted reasoning effort before inference', async () => {
  const adapter = new ChatGPTSiwcAdapter(dependencies({ websocket: false }))
  try {
    const resolved = await adapter.resolveModel('chatgpt-siwc', model)
    assert.equal(resolved.context?.contextWindow, 32_000)
    assert.deepEqual(resolved.inputModalities, ['text'])
    assert.deepEqual(resolved.reasoning?.efforts.map(item => item.id), ['low', 'high'])
    assert.equal(resolved.reasoning?.defaultEffort, 'low')
    await assert.rejects(assembled(adapter, options({ reasoningEffort: ReasoningEffortId('unsupported') })),
      { code: 'SIWC_UNSUPPORTED_REASONING' })
  } finally { adapter.dispose() }
})

test('disposing the adapter terminates an active socket without replaying its visible output', async () => {
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const server = await fixture(socket => {
    socket.send(JSON.stringify({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'partial' }))
    started()
  })
  const adapter = new ChatGPTSiwcAdapter(dependencies({ socketFactory: server.socketFactory }))
  try {
    const running = assembled(adapter)
    const rejected = assert.rejects(running)
    await ready
    adapter.dispose()
    await rejected
    assert.equal(server.messages.length, 1)
  } finally { adapter.dispose(); await server.close() }
})

test('adapter captures raw server cache evidence and wire identity before usage normalization', async () => {
  const records: RequestDiagnostic[] = []
  const diagnostics = new RequestDiagnostics({record: value => {records.push(value)}}, () => 'conversation')
  const event = completed('private-server-response')
  const response = event.response as Record<string, unknown>
  response.model = model
  const adapter = new ChatGPTSiwcAdapter(dependencies({diagnostics, websocket: false,
    fetch: async url => String(url).endsWith('/models') ? catalog() : new Response(`data: ${JSON.stringify(event)}\n\n`),
  }))
  try {
    await assembled(adapter)
    assert.equal(records[0].metering?.cache, 'positive')
    assert.equal(records[0].metering?.reportedCachedTokens, 4)
    assert.equal(records[0].server?.model, model)
    assert.match(records[0].routing!.wireSessionHash, /^[a-f0-9]{64}$/)
    assert.equal(JSON.stringify(records).includes('private-server-response'), false)
    assert.equal(JSON.stringify(records).includes('synthetic-access'), false)
  } finally {adapter.dispose()}
})
