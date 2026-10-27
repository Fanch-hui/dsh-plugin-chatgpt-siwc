import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import WebSocket, {WebSocketServer} from 'ws'
import { createAttemptBudget, ResponsesTransport, type DisconnectDiagnostic, type TransportOptions, type TransportRequest, type TransportDecision, type WireEvent } from '../src/provider/transport/index.js'
import { authenticatedFetch } from '../src/provider/http.js'
import { SocketInterrupted } from '../src/provider/transport/socket.js'

type Server = Awaited<ReturnType<typeof fixture>>
const input = [{role: 'user', content: 'hello'}]
const output = [{type: 'message', id: 'msg-one', role: 'assistant', content: [{type: 'output_text', text: 'OK', annotations: []}]}]
const completed = (id = 'resp-one', items = output): WireEvent => ({type: 'response.completed', response: {id, status: 'completed', output: items}})
const body = (items: unknown[] = input) => ({model: 'fixture-model', store: false, stream: true, input: items, tools: []})
const request = (overrides: Partial<TransportRequest> = {}): TransportRequest => ({body: body(), sessionId: 'session-one', connectionId: 'connection-one', accessToken: 'fixture-access', ...overrides})
async function collect(events: AsyncIterable<WireEvent>): Promise<WireEvent[]> { const result = []; for await (const event of events) result.push(event); return result }

async function fixture(handler: (socket: WebSocket, request: Record<string, unknown>) => void) {
  const server = new WebSocketServer({port: 0, host: '127.0.0.1'})
  try { await once(server, 'listening') }
  catch (error) { server.close(); throw error }
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Local server did not start')
  const headers: Record<string, unknown>[] = []
  const messages: Record<string, unknown>[] = []
  const clients: WebSocket[] = []
  let connections = 0
  server.on('connection', (socket, incoming) => {
    connections++
    headers.push(incoming.headers)
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>
      messages.push(message)
      handler(socket, message)
    })
  })
  const socketFactory: NonNullable<TransportOptions['socketFactory']> = async (headers, signal) => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}`, {headers})
    clients.push(socket)
    const cancel = () => socket.terminate()
    signal?.addEventListener('abort', cancel, {once: true})
    try { await once(socket, 'open'); return socket }
    catch { socket.on('error', () => {}); throw new SocketInterrupted() }
    finally { signal?.removeEventListener('abort', cancel) }
  }
  return {headers, messages, clients, socketFactory, connections: () => connections, async close() {
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }}
}
function transport(server: Server, options: Partial<TransportOptions> = {}) {
  return new ResponsesTransport({socketFactory: server.socketFactory, http: async () => { throw new Error('Unexpected HTTP fallback') }, ...options})
}
function sse(event: WireEvent): Response { return new Response(`data: ${JSON.stringify(event)}\n\n`, {headers: {'content-type': 'text/event-stream'}}) }

test('reuses a socket and sends incremental input only after durable confirmation', async () => {
  const server = await fixture(socket => socket.send(JSON.stringify(completed())))
  const wire = transport(server, {headers: {'x-fixture-attribution': 'test'}})
  const decisions: TransportDecision[] = []
  try {
    await collect(wire.stream(request({onDecision: decision => decisions.push(decision)})))
    const extra = {role: 'user', content: 'continue'}
    await collect(wire.stream(request({body: body([...input, ...output, extra]), confirmedResponseIds: new Set(['resp-one']), onDecision: decision => decisions.push(decision)})))
    assert.deepEqual(decisions.map(({connection: _connection, ...decision}) => decision), [{mode: 'ws-full', reason: 'cold-connection'}, {mode: 'ws-incremental', reason: 'continued'}])
    assert.equal(decisions[0].connection?.state, 'new')
    assert.equal(decisions[0].connection?.cause, 'first-use')
    assert.equal(decisions[1].connection?.state, 'reused')
    assert.equal(typeof decisions[1].connection?.ageMs, 'number')
    assert.equal(server.connections(), 1)
    assert.equal(server.headers[0]['session-id'], 'session-one')
    assert.equal(server.headers[0].authorization, 'Bearer fixture-access')
    assert.equal(server.headers[0]['x-fixture-attribution'], 'test')
    assert.equal(server.messages[0].type, 'response.create')
    assert.equal('stream' in server.messages[0], false)
    assert.equal(server.messages[0].store, false)
    assert.equal(server.messages[1].previous_response_id, 'resp-one')
    assert.deepEqual(server.messages[1].input, [extra])
  } finally { wire.dispose(); await server.close() }
})

test('unconfirmed responses and changed context or settings send full input', async () => {
  const server = await fixture(socket => socket.send(JSON.stringify(completed())))
  const wire = transport(server)
  const decisions: TransportDecision[] = []
  try {
    await collect(wire.stream(request()))
    const history = [...input, ...output, {role: 'user', content: 'more'}]
    await collect(wire.stream(request({body: body(history), onDecision: decision => decisions.push(decision)})))
    assert.equal('previous_response_id' in server.messages[1], false)
    await collect(wire.stream(request({body: {...body(history), tools: [{type: 'namespace', name: 'changed', tools: []}]}, confirmedResponseIds: new Set(['resp-one']), onDecision: decision => decisions.push(decision)})))
    assert.equal('previous_response_id' in server.messages[2], false)
    assert.deepEqual(server.messages[2].input, history)
    assert.deepEqual(decisions.map(({connection: _connection, ...decision}) => decision), [{mode: 'ws-full', reason: 'unconfirmed-response'}, {mode: 'ws-full', reason: 'settings-changed'}])
  } finally { wire.dispose(); await server.close() }
})

test('credential changes and concurrent calls use separate sockets', async () => {
  const server = await fixture(socket => { setTimeout(() => socket.send(JSON.stringify(completed())), 15) })
  const wire = transport(server)
  try {
    await Promise.all([collect(wire.stream(request())), collect(wire.stream(request()))])
    assert.equal(server.connections(), 2)
    await collect(wire.stream(request({accessToken: 'fixture-rotated'})))
    assert.equal(server.connections(), 3)
    assert.equal(server.headers[2].authorization, 'Bearer fixture-rotated')
    await collect(wire.stream(request({connectionId: 'connection-two'})))
    assert.equal(server.connections(), 4)
  } finally { wire.dispose(); await server.close() }
})

test('missing previous response retries full input once on the same socket', async () => {
  const server = await fixture((socket, message) => {
    socket.send(JSON.stringify(message.previous_response_id
      ? {type: 'error', error: {code: 'previous_response_not_found'}} : completed()))
  })
  const wire = transport(server)
  const decisions: TransportDecision[] = []
  const sentBodies: Record<string, unknown>[] = []
  const onRequestBody = (payload: Record<string, unknown>) => { sentBodies.push(payload); throw new Error('observer') }
  try {
    await collect(wire.stream(request({onRequestBody})))
    const history = [...input, ...output, {role: 'user', content: 'more'}]
    await collect(wire.stream(request({onRequestBody, body: body(history), confirmedResponseIds: new Set(['resp-one']), onDecision: decision => decisions.push(decision)})))
    assert.deepEqual(decisions.map(({connection: _connection, ...decision}) => decision), [{mode: 'ws-incremental', reason: 'continued'}, {mode: 'ws-full', reason: 'previous-response-missing'}])
    assert.equal(server.messages.length, 3)
    assert.equal(server.messages[1].previous_response_id, 'resp-one')
    assert.equal('previous_response_id' in server.messages[2], false)
    assert.deepEqual(server.messages[2].input, history)
    assert.deepEqual(sentBodies.map(payload => payload.input), [input, history.slice(input.length + output.length), history])
    assert.equal(sentBodies[1].previous_response_id, 'resp-one')
    assert.equal('previous_response_id' in sentBodies[2], false)
  } finally { wire.dispose(); await server.close() }
})

test('connection failure before output falls back to one full HTTP request', async () => {
  const server = await fixture(socket => socket.terminate())
  let http = 0
  const decisions: TransportDecision[] = []
  const sentBodies: Record<string, unknown>[] = []
  const wire = transport(server, {http: async (payload, headers) => {
    http++
    assert.equal(payload.stream, true)
    assert.equal(payload.store, false)
    assert.equal('previous_response_id' in payload, false)
    assert.deepEqual(payload.input, input)
    assert.equal(headers['session-id'], 'session-one')
    return sse(completed())
  }})
  try {
    const events = await collect(wire.stream(request({onRequestBody: payload => { sentBodies.push(payload); throw new Error('observer') }, onDecision: decision => decisions.push(decision)})))
    assert.deepEqual(decisions.map(({connection: _connection, ...decision}) => decision), [{mode: 'ws-full', reason: 'cold-connection'}, {mode: 'http-fallback', reason: 'socket-fallback'}])
    assert.equal(http, 1)
    assert.equal(sentBodies.length, 2)
    assert.deepEqual(sentBodies.map(payload => payload.input), [input, input])
    assert.equal('stream' in sentBodies[0], false)
    assert.equal(sentBodies[1].stream, true)
    assert.equal(events.at(-1)?.type, 'response.completed')
  } finally { wire.dispose(); await server.close() }
})

test('handshake failure and pre-output placeholder interruption fall back once while output interruption does not replay', async () => {
  const wire = new ResponsesTransport({socketFactory: async () => { throw new SocketInterrupted() }, http: async () => sse(completed())})
  try { assert.equal((await collect(wire.stream(request()))).at(-1)?.type, 'response.completed') }
  finally { wire.dispose() }
  let placeholderHttp = 0
  const placeholderDisconnects: {cause: string; closeCode?: number; lastEventType?: string; lastEventSequence?: number}[] = []
  const placeholderServer = await fixture(socket => {
    socket.send(JSON.stringify({type: 'response.created', sequence_number: 1, response: {id: 'resp-placeholder', status: 'in_progress'}}))
    socket.send(JSON.stringify({type: 'response.output_item.added', sequence_number: 2, output_index: 0, item: {type: 'reasoning', id: 'rs-placeholder', summary: []}}))
    socket.send(JSON.stringify({type: 'response.reasoning_summary_text.delta', sequence_number: 3, output_index: 0, delta: ''}))
    socket.send(JSON.stringify({type: 'response.output_item.done', sequence_number: 4, output_index: 0, item: {type: 'reasoning', id: 'rs-placeholder', encrypted_content: 'enc-placeholder', summary: []}}))
    socket.send(JSON.stringify({type: 'response.output_text.delta', sequence_number: 5, output_index: 1, content_index: 0, delta: ''}))
    socket.send(JSON.stringify({type: 'response.output_item.done', sequence_number: 6, output_index: 1, item: {type: 'message', id: 'msg-empty', role: 'assistant', content: []}}))
    setTimeout(() => socket.close(1001), 5)
  })
  const placeholderTransport = transport(placeholderServer, {http: async () => { placeholderHttp++; return sse(completed('resp-recovered')) }})
  try {
    const events = await collect(placeholderTransport.stream(request({onDisconnect: info => placeholderDisconnects.push(info)})))
    assert.equal(placeholderHttp, 1)
    assert.equal(events.at(-1)?.type, 'response.completed')
    assert.deepEqual(placeholderDisconnects, [{cause: 'remote-closed', closeCode: 1001, lastEventType: 'response.output_item.done', lastEventSequence: 6}])
  } finally { placeholderTransport.dispose(); await placeholderServer.close() }
  let http = 0
  const disconnects: {cause: string; lastEventType?: string; lastEventSequence?: number}[] = []
  const server = await fixture((socket, message) => {
    if (message.model === 'error') socket.send(JSON.stringify({type: 'response.failed', response: {error: {code: 'subscription_sharing_usage_limit_exceeded'}}}))
    else { socket.send(JSON.stringify({type: 'response.output_text.delta', delta: 'visible'})); setTimeout(() => socket.terminate(), 5) }
  })
  const active = transport(server, {http: async () => { http++; return sse(completed()) }})
  try {
    const failed = await collect(active.stream(request({body: {...body(), model: 'error'}})))
    assert.equal(failed.at(-1)?.type, 'response.failed')
    await assert.rejects(collect(active.stream(request({onDisconnect: info => disconnects.push(info)}))), {code: 'SIWC_SOCKET_INTERRUPTED'})
    assert.equal(http, 0)
    assert.equal(disconnects.length, 1)
    assert.equal(disconnects[0].lastEventType, 'response.output_text.delta')
    assert.equal(disconnects[0].lastEventSequence, 1)
  } finally { active.dispose(); await server.close() }
})

test('abort and disposal release active requests without HTTP fallback', async () => {
  let accepted!: () => void
  let wait = new Promise<void>(resolve => { accepted = resolve })
  const server = await fixture(() => accepted())
  const wire = transport(server)
  try {
    const cancel = new AbortController()
    const pending = collect(wire.stream(request({signal: cancel.signal})))
    await wait
    cancel.abort(new DOMException('Fixture cancellation', 'AbortError'))
    await assert.rejects(pending, {name: 'AbortError'})
    wait = new Promise<void>(resolve => { accepted = resolve })
    const reconnect: TransportDecision[] = []
    const next = collect(wire.stream(request({onDecision: decision => reconnect.push(decision)})))
    await wait
    assert.equal(reconnect[0].connection?.cause, 'cancelled')
    wire.dispose()
    await assert.rejects(next, {name: 'AbortError'})
  } finally { wire.dispose(); await server.close() }
})

test('idle capacity and expiry remove sockets and force a fresh full request', async () => {
  const server = await fixture(socket => socket.send(JSON.stringify(completed())))
  const wire = transport(server, {maxIdle: 1, idleMs: 30})
  try {
    await collect(wire.stream(request()))
    await collect(wire.stream(request({sessionId: 'session-two'})))
    await collect(wire.stream(request()))
    assert.equal(server.connections(), 3)
    await new Promise(resolve => setTimeout(resolve, 45))
    await collect(wire.stream(request()))
    assert.equal(server.connections(), 4)
    assert.equal('previous_response_id' in server.messages.at(-1)!, false)
  } finally { wire.dispose(); await server.close() }
})

test('idle socket errors close the cached connection and the next request reconnects', async () => {
  const server = await fixture(socket => socket.send(JSON.stringify(completed())))
  const wire = transport(server)
  try {
    await collect(wire.stream(request()))
    const idle = server.clients[0]
    assert.ok(idle.listenerCount('error') > 0)
    assert.doesNotThrow(() => idle.emit('error', new Error('Fixture idle disconnect')))
    await once(idle, 'close')
    const reconnect: TransportDecision[] = []
    await collect(wire.stream(request({onDecision: decision => reconnect.push(decision)})))
    assert.equal(reconnect[0].connection?.cause, 'socket-error')
    assert.equal(reconnect[0].connection?.closeCode, 1006)
    assert.equal(server.connections(), 2)
    assert.equal('previous_response_id' in server.messages[1], false)
  } finally { wire.dispose(); await server.close() }
})

test('malformed and oversized frames terminate before a queued completed event', async () => {
  for (const payload of ['{malformed', JSON.stringify({type: 'response.output_text.delta', delta: 'x'.repeat(17 * 1024 * 1024)})]) {
    let http = 0
    const server = await fixture(socket => {
      socket.send(payload)
      socket.send(JSON.stringify(completed()))
    })
    const wire = transport(server, {http: async () => { http++; return sse(completed()) }})
    const seen: WireEvent[] = []
    try {
      await assert.rejects(async () => {
        for await (const event of wire.stream(request())) seen.push(event)
      }, {code: 'SIWC_INVALID_STREAM'})
      assert.equal(seen.some(event => event.type === 'response.completed'), false)
      assert.equal(http, 0)
    } finally { wire.dispose(); await server.close() }
  }
})

test('a graceful network close permits an already queued completed event', async () => {
  const server = await fixture(socket => {
    socket.send(JSON.stringify(completed()))
    socket.close()
  })
  const wire = transport(server)
  try { assert.equal((await collect(wire.stream(request()))).at(-1)?.type, 'response.completed') }
  finally { wire.dispose(); await server.close() }
})


test('prefix diagnostics identify the first changed or missing item without exposing content', async () => {
  for (const history of [[{role: 'user', content: 'edited'}, ...output], [...input]]) {
    const server = await fixture(socket => socket.send(JSON.stringify(completed())))
    const wire = transport(server)
    const decisions: TransportDecision[] = []
    try {
      await collect(wire.stream(request()))
      await collect(wire.stream(request({body: body(history), confirmedResponseIds: new Set(['resp-one']),
        onDecision: decision => decisions.push(decision)})))
      assert.deepEqual(decisions.map(({connection: _connection, ...decision}) => decision), [{mode: 'ws-full', reason: 'prefix-changed', firstDifference: history.length === 1 ? 1 : 0}])
      assert.equal('previous_response_id' in server.messages[1], false)
    } finally { wire.dispose(); await server.close() }
  }
})

test('an observer failure does not alter socket delivery, continuation or HTTP fallback', async () => {
  const server = await fixture(socket => socket.send(JSON.stringify(completed())))
  const wire = transport(server)
  const onDecision = () => { throw new Error('synthetic observer failure') }
  try {
    await collect(wire.stream(request({onDecision})))
    await collect(wire.stream(request({body: body([...input, ...output]), confirmedResponseIds: new Set(['resp-one']), onDecision})))
    assert.equal(server.messages[1].previous_response_id, 'resp-one')
  } finally { wire.dispose(); await server.close() }
  const fallback = new ResponsesTransport({socketFactory: async () => { throw new SocketInterrupted() },
    http: async () => sse(completed())})
  try {
    assert.equal((await collect(fallback.stream(request({onDecision})))).at(-1)?.type, 'response.completed')
  } finally { fallback.dispose() }
})


test('default pool retains confirmed continuation across a long idle period', async (t) => {
  const server = await fixture(socket => socket.send(JSON.stringify(completed())))
  const wire = transport(server)
  try {
    await collect(wire.stream(request()))
    const future = Date.now() + 20 * 60_000
    const futureMono = performance.now() + 20 * 60_000
    t.mock.method(Date, 'now', () => future)
    t.mock.method(performance, 'now', () => futureMono)
    const decisions: TransportDecision[] = []
    await collect(wire.stream(request({body: body([...input, ...output, {role: 'user', content: 'later'}]),
      confirmedResponseIds: new Set(['resp-one']), onDecision: decision => decisions.push(decision)})))
    assert.equal(server.connections(), 1)
    assert.deepEqual(decisions.map(({connection: _connection, ...decision}) => decision), [{mode: 'ws-incremental', reason: 'continued'}])
    assert.equal(server.messages[1].previous_response_id, 'resp-one')
  } finally { t.mock.restoreAll(); wire.dispose(); await server.close() }
})

test('rotates socket at 50-minute planned rotation threshold and drains active stream crossing threshold', async (t) => {
  let now = Date.now()
  let mono = performance.now()
  t.mock.method(Date, 'now', () => now)
  t.mock.method(performance, 'now', () => mono)
  const server = await fixture((socket, message) => {
    if ((message.input as {content?: string}[])?.[0]?.content === 'cross-threshold') {
      now += 51 * 60_000
      mono += 51 * 60_000
    }
    socket.send(JSON.stringify(completed()))
  })
  const wire = transport(server)
  try {
    // 1. Idle socket reaching >= 50m rotates with planned-rotation and sends full request on a new connection
    await collect(wire.stream(request()))
    now += 50 * 60_000
    mono += 50 * 60_000
    const rotatedDecisions: TransportDecision[] = []
    await collect(wire.stream(request({
      body: body([...input, ...output, {role: 'user', content: 'after-50m'}]),
      confirmedResponseIds: new Set(['resp-one']),
      onDecision: decision => rotatedDecisions.push(decision),
    })))
    assert.equal(server.connections(), 2)
    assert.equal(rotatedDecisions[0].mode, 'ws-full')
    assert.equal(rotatedDecisions[0].connection?.cause, 'planned-rotation')
    assert.equal('previous_response_id' in server.messages[1], false)

    // 2. Active stream crossing 50m completes response (draining) and rotates on the following turn
    await collect(wire.stream(request({
      sessionId: 'session-drain',
      body: body([{role: 'user', content: 'cross-threshold'}]),
    })))
    assert.equal(server.connections(), 3)
    const afterDrainDecisions: TransportDecision[] = []
    await collect(wire.stream(request({
      sessionId: 'session-drain',
      body: body([{role: 'user', content: 'cross-threshold'}, ...output, {role: 'user', content: 'next-turn'}]),
      confirmedResponseIds: new Set(['resp-one']),
      onDecision: decision => afterDrainDecisions.push(decision),
    })))
    assert.equal(server.connections(), 4)
    assert.equal(afterDrainDecisions[0].mode, 'ws-full')
    assert.equal(afterDrainDecisions[0].connection?.cause, 'planned-rotation')
  } finally { t.mock.restoreAll(); wire.dispose(); await server.close() }
})

test('token generation race in transport keeps newer idle socket and retires late older generation', async () => {
  const server = await fixture(socket => socket.send(JSON.stringify(completed())))
  const wire = transport(server)
  try {
    await collect(wire.stream(request({accessToken: 'token-gen-8', credentialGeneration: 8})))
    assert.equal(server.connections(), 1)

    // Late request from generation 7 runs and retires on release without evicting generation 8
    await collect(wire.stream(request({accessToken: 'token-gen-7', credentialGeneration: 7})))
    assert.equal(server.connections(), 2)

    const decisions: TransportDecision[] = []
    await collect(wire.stream(request({
      accessToken: 'token-gen-8',
      credentialGeneration: 8,
      body: body([...input, ...output, {role: 'user', content: 'continue-gen-8'}]),
      confirmedResponseIds: new Set(['resp-one']),
      onDecision: decision => decisions.push(decision),
    })))
    assert.equal(server.connections(), 2)
    assert.equal(decisions[0].mode, 'ws-incremental')
    assert.equal(decisions[0].connection?.state, 'reused')
  } finally { wire.dispose(); await server.close() }
})

test('pre-borrow ping/pong probe failure reconnects on the same request without consuming send budget', async () => {
  const server = await fixture(socket => socket.send(JSON.stringify(completed())))
  const wire = transport(server, {pongTimeoutMs: 25, probeIdleMs: 10})
  try {
    await collect(wire.stream(request()))
    assert.equal(server.connections(), 1)
    // Simulate a blackholed socket that ignores ping frames (suppress pong)
    server.clients[0].ping = (() => {}) as typeof WebSocket.prototype.ping
    wire.notifyNetworkChange()

    const budget = createAttemptBudget()
    const decisions: TransportDecision[] = []
    const events = await collect(wire.stream(request({
      budget,
      body: body([...input, ...output, {role: 'user', content: 'after-probe-fail'}]),
      confirmedResponseIds: new Set(['resp-one']),
      onDecision: decision => decisions.push(decision),
    })))
    assert.equal(events.at(-1)?.type, 'response.completed')
    assert.equal(server.connections(), 2)
    assert.equal(decisions.length, 1)
    assert.equal(decisions[0].mode, 'ws-full')
    assert.equal(decisions[0].connection?.cause, 'health-check-failed')
    assert.equal(budget.sendsUsed, 1)
    assert.equal(budget.handshakesUsed, 1)
  } finally { wire.dispose(); await server.close() }
})

test('websocket cooldown bypasses repeated failed handshakes and allows a single recovery prober on expiry or network change', async (t) => {
  let now = 10_000
  t.mock.method(Date, 'now', () => now)
  let handshakeAttempts = 0
  let failHandshake = true
  let releaseProbe!: () => void
  const probeGate = new Promise<void>(resolve => { releaseProbe = resolve })
  let blockProbe = false
  const server = await fixture(socket => socket.send(JSON.stringify(completed('resp-ws'))))
  let httpCalls = 0
  const wire = new ResponsesTransport({
    cooldownBaseMs: 30_000,
    cooldownMaxMs: 300_000,
    socketFactory: async (headers, signal) => {
      handshakeAttempts++
      if (blockProbe) await probeGate
      if (failHandshake) throw new SocketInterrupted({cause: 'handshake-failed'})
      return server.socketFactory(headers, signal)
    },
    http: async () => {
      httpCalls++
      return sse(completed(`resp-http-${httpCalls}`))
    },
  })
  try {
    // 1. Initial WS handshake fails -> falls back to HTTP and enters 30s cooldown
    const firstDecisions: TransportDecision[] = []
    await collect(wire.stream(request({onDecision: d => firstDecisions.push(d)})))
    assert.equal(handshakeAttempts, 1)
    assert.equal(httpCalls, 1)
    assert.equal(firstDecisions[0].reason, 'socket-fallback')

    // 2. Request during cooldown window bypasses WS handshake directly to HTTP with reason ws-cooldown
    now += 5_000
    const secondBudget = createAttemptBudget()
    const secondDecisions: TransportDecision[] = []
    await collect(wire.stream(request({budget: secondBudget, onDecision: d => secondDecisions.push(d)})))
    assert.equal(handshakeAttempts, 1)
    assert.equal(httpCalls, 2)
    assert.equal(secondBudget.handshakesUsed, 0)
    assert.equal(secondBudget.sendsUsed, 1)
    assert.equal(secondDecisions[0].mode, 'http-fallback')
    assert.equal(secondDecisions[0].reason, 'ws-cooldown')

    // 3. When cooldown expires (or notifyNetworkChange), only one concurrent request probes WS while another uses HTTP
    wire.notifyNetworkChange()
    failHandshake = false
    blockProbe = true
    const probeDecisions: TransportDecision[] = []
    const concurrentDecisions: TransportDecision[] = []
    const proberPromise = collect(wire.stream(request({sessionId: 's-prober', onDecision: d => probeDecisions.push(d)})))
    await new Promise(resolve => setTimeout(resolve, 10))
    const concurrentPromise = collect(wire.stream(request({sessionId: 's-concurrent', onDecision: d => concurrentDecisions.push(d)})))
    await concurrentPromise
    assert.equal(handshakeAttempts, 2)
    assert.equal(httpCalls, 3)
    assert.equal(concurrentDecisions[0].reason, 'ws-cooldown')

    blockProbe = false
    releaseProbe()
    const proberEvents = await proberPromise
    assert.equal((proberEvents.at(-1)?.response as {id?: string})?.id, 'resp-ws')
    assert.equal(probeDecisions[0].mode, 'ws-full')
  } finally { t.mock.restoreAll(); wire.dispose(); await server.close() }
})

test('recovery probe holds ownership until the first server event', async (t) => {
  let now = 20_000
  t.mock.method(Date, 'now', () => now)
  let handshakeAttempts = 0
  let failHandshake = true
  let httpCalls = 0
  let receiveProbe!: (socket: WebSocket) => void
  const probeReceived = new Promise<WebSocket>(resolve => { receiveProbe = resolve })
  let receiveFirstEvent!: () => void
  const firstEventReceived = new Promise<void>(resolve => { receiveFirstEvent = resolve })
  const server = await fixture((socket, message) => {
    if ((message.input as {content?: string}[])?.[0]?.content === 'await-first-event') {
      receiveProbe(socket)
      return
    }
    socket.send(JSON.stringify(completed('resp-ready')))
  })
  const wire = new ResponsesTransport({
    socketFactory: async (headers, signal) => {
      handshakeAttempts++
      if (failHandshake) throw new SocketInterrupted({cause: 'handshake-failed'})
      return server.socketFactory(headers, signal)
    },
    http: async () => { httpCalls++; return sse(completed('resp-http')) },
  })
  let probeRequest: Promise<WireEvent[]> | undefined
  try {
    await collect(wire.stream(request()))
    failHandshake = false
    now += 30_001
    probeRequest = collect(wire.stream(request({
      sessionId: 'recovery-probe',
      body: body([{role: 'user', content: 'await-first-event'}]),
      onTiming: stage => { if (stage === 'first-event') receiveFirstEvent() },
    })))
    const socket = await probeReceived
    const concurrentBudget = createAttemptBudget()
    const concurrentDecisions: TransportDecision[] = []
    await collect(wire.stream(request({
      sessionId: 'during-probe',
      budget: concurrentBudget,
      onDecision: decision => concurrentDecisions.push(decision),
    })))
    assert.equal(handshakeAttempts, 2)
    assert.equal(server.connections(), 1)
    assert.equal(httpCalls, 2)
    assert.equal(concurrentBudget.handshakesUsed, 0)
    assert.equal(concurrentDecisions[0].reason, 'ws-cooldown')

    socket.send(JSON.stringify({type: 'response.created', response: {id: 'resp-probe', status: 'in_progress'}}))
    await firstEventReceived
    await collect(wire.stream(request({sessionId: 'after-probe-event'})))
    assert.equal(handshakeAttempts, 3)
    assert.equal(server.connections(), 2)
    assert.equal(httpCalls, 2)
    socket.send(JSON.stringify(completed('resp-probe')))
    assert.equal((await probeRequest).at(-1)?.type, 'response.completed')
  } finally {
    wire.dispose()
    await probeRequest?.catch(() => {})
    await server.close()
    t.mock.restoreAll()
  }
})

test('comparison_response_id change in prompt_cache_options preserves ws-incremental continuation', async () => {
  const server = await fixture(socket => socket.send(JSON.stringify(completed())))
  const wire = transport(server)
  const decisions: TransportDecision[] = []
  try {
    await collect(wire.stream(request({
      body: {...body(input), prompt_cache_options: {mode: 'implicit', ttl: '30m'}},
      onDecision: d => decisions.push(d),
    })))
    const extra = {role: 'user', content: 'next turn'}
    await collect(wire.stream(request({
      body: {
        ...body([...input, ...output, extra]),
        prompt_cache_options: {mode: 'implicit', ttl: '30m', comparison_response_id: 'resp-one'},
      },
      confirmedResponseIds: new Set(['resp-one']),
      onDecision: d => decisions.push(d),
    })))
    assert.deepEqual(decisions.map(({connection: _connection, ...decision}) => decision), [
      {mode: 'ws-full', reason: 'cold-connection'},
      {mode: 'ws-incremental', reason: 'continued'},
    ])
    assert.equal(server.messages[1].previous_response_id, 'resp-one')
    assert.deepEqual(server.messages[1].input, [extra])
    assert.deepEqual(server.messages[1].prompt_cache_options, {
      mode: 'implicit',
      ttl: '30m',
      comparison_response_id: 'resp-one',
    })
  } finally { wire.dispose(); await server.close() }
})

test('late handshake completing after wire.invalidate closes the new socket immediately without HTTP fallback', async () => {
  let releaseHandshake!: () => void
  const handshakeGate = new Promise<void>(resolve => { releaseHandshake = resolve })
  const server = await fixture(socket => socket.send(JSON.stringify(completed())))
  let httpCalls = 0
  let createdSocket: WebSocket | undefined
  const wire = new ResponsesTransport({
    socketFactory: async (headers, signal) => {
      const sock = await server.socketFactory(headers, signal)
      createdSocket = sock
      await handshakeGate
      return sock
    },
    http: async () => { httpCalls++; return sse(completed()) },
  })
  try {
    const streamPromise = collect(wire.stream(request()))
    await new Promise(resolve => setTimeout(resolve, 15))
    assert.equal(createdSocket?.readyState, WebSocket.OPEN)
    wire.invalidate('connection-one')
    releaseHandshake()
    await assert.rejects(streamPromise, {code: 'SIWC_SOCKET_INTERRUPTED'})
    assert.equal(httpCalls, 0)
    assert.notEqual(createdSocket?.readyState, WebSocket.OPEN)
  } finally { wire.dispose(); await server.close() }
})

test('shared AttemptBudget caps WS send failure + HTTP fallback + HTTP 401 token_expired at maxSends: 2', async () => {
  const server = await fixture(socket => socket.terminate())
  let fetchCalls = 0
  let renewCalls = 0
  const expiredResponse = () => new Response(JSON.stringify({error: {code: 'token_expired'}}), {
    status: 401,
    headers: {'content-type': 'application/json'},
  })
  const wire = transport(server, {
    http: (payload, headers, signal, connectionId, budget) =>
      authenticatedFetch(
        async () => {
          fetchCalls++
          return fetchCalls === 1 ? expiredResponse() : sse(completed('resp-after-refresh'))
        },
        async () => {
          renewCalls++
          return {id: connectionId, accessToken: 'refreshed-token', accountId: 'acc-1'}
        },
        connectionId,
        'https://chatgpt.com/backend-api/codex/responses',
        {method: 'POST', headers, body: JSON.stringify(payload), signal},
        budget,
      ),
  })
  try {
    const wsFallbackBudget = createAttemptBudget()
    await assert.rejects(collect(wire.stream(request({budget: wsFallbackBudget}))), {code: 'AUTH'})
    assert.equal(wsFallbackBudget.sendsUsed, 2)
    assert.equal(wsFallbackBudget.tokenRefreshesUsed, 0)
    assert.equal(fetchCalls, 1)
    assert.equal(renewCalls, 0)

    fetchCalls = 0
    renewCalls = 0
    const directBudget = createAttemptBudget({sendsUsed: 1, attempt: 1})
    const directRes = await authenticatedFetch(
      async () => {
        fetchCalls++
        return fetchCalls === 1 ? expiredResponse() : sse(completed('resp-direct-refreshed'))
      },
      async () => {
        renewCalls++
        return {id: 'connection-one', accessToken: 'refreshed-token', accountId: 'acc-1'}
      },
      'connection-one',
      'https://chatgpt.com/backend-api/codex/responses',
      {method: 'POST', headers: {authorization: 'Bearer old-token'}},
      directBudget,
    )
    assert.equal(directRes.status, 200)
    assert.equal(fetchCalls, 2)
    assert.equal(renewCalls, 1)
    assert.equal(directBudget.tokenRefreshesUsed, 1)
    assert.equal(directBudget.sendsUsed, 2)
    assert.equal(directBudget.attempt, 2)
  } finally { wire.dispose(); await server.close() }
})

test('websocket_connection_limit_reached retires socket and recovers via HTTP before output but does not replay after output', async () => {
  let turn = 0
  const server = await fixture(socket => {
    turn++
    if (turn === 1) {
      socket.send(JSON.stringify({type: 'error', sequence_number: 1, error: {code: 'websocket_connection_limit_reached'}}))
    } else if (turn === 2) {
      socket.send(JSON.stringify({type: 'response.output_text.delta', sequence_number: 1, delta: 'partial'}))
      socket.send(JSON.stringify({type: 'error', sequence_number: 2, error: {code: 'websocket_connection_limit_reached'}}))
    } else {
      socket.send(JSON.stringify(completed('resp-ws-3')))
    }
  })
  let httpCalls = 0
  const wire = transport(server, {
    http: async () => {
      httpCalls++
      return sse(completed(`resp-http-${httpCalls}`))
    },
  })
  try {
    const firstDecisions: TransportDecision[] = []
    const firstDisconnects: DisconnectDiagnostic[] = []
    const firstEvents = await collect(wire.stream(request({
      onDecision: d => firstDecisions.push(d),
      onDisconnect: d => firstDisconnects.push(d),
    })))
    assert.equal(httpCalls, 1)
    assert.equal((firstEvents.at(-1)?.response as {id?: string})?.id, 'resp-http-1')
    assert.deepEqual(firstDisconnects, [{cause: 'connection-limit', lastEventType: 'error', lastEventSequence: 1}])
    assert.deepEqual(firstDecisions.map(({connection: _c, ...d}) => d), [
      {mode: 'ws-full', reason: 'cold-connection'},
      {mode: 'http-fallback', reason: 'connection-limit'},
    ])

    const secondDecisions: TransportDecision[] = []
    const secondDisconnects: DisconnectDiagnostic[] = []
    const secondEvents = await collect(wire.stream(request({
      onDecision: d => secondDecisions.push(d),
      onDisconnect: d => secondDisconnects.push(d),
    })))
    assert.equal(httpCalls, 1)
    assert.equal(server.connections(), 2)
    assert.equal(secondDecisions[0].connection?.cause, 'connection-limit')
    assert.deepEqual(secondDisconnects, [{cause: 'connection-limit', lastEventType: 'error', lastEventSequence: 2}])
    assert.equal(secondEvents.at(-1)?.type, 'error')
  } finally { wire.dispose(); await server.close() }
})

test('handshake succeeding followed by immediate close before any server event increments failure count and enters ws-cooldown', async (t) => {
  let now = 20_000
  t.mock.method(Date, 'now', () => now)
  const server = await fixture(socket => socket.close(1011))
  let httpCalls = 0
  const wire = transport(server, {
    cooldownBaseMs: 30_000,
    cooldownMaxMs: 300_000,
    http: async () => {
      httpCalls++
      return sse(completed(`resp-http-${httpCalls}`))
    },
  })
  try {
    const firstDecisions: TransportDecision[] = []
    await collect(wire.stream(request({onDecision: d => firstDecisions.push(d)})))
    assert.equal(server.connections(), 1)
    assert.equal(httpCalls, 1)
    assert.equal(firstDecisions.at(-1)?.reason, 'socket-fallback')

    now += 5_000
    const secondDecisions: TransportDecision[] = []
    const secondBudget = createAttemptBudget()
    await collect(wire.stream(request({budget: secondBudget, onDecision: d => secondDecisions.push(d)})))
    assert.equal(server.connections(), 1)
    assert.equal(httpCalls, 2)
    assert.equal(secondBudget.handshakesUsed, 0)
    assert.equal(secondDecisions[0].mode, 'http-fallback')
    assert.equal(secondDecisions[0].reason, 'ws-cooldown')
  } finally { t.mock.restoreAll(); wire.dispose(); await server.close() }
})
