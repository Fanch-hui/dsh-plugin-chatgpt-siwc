import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import WebSocket, { WebSocketServer } from 'ws'
import { ChatGPTSiwcAdapter } from '../src/provider/adapter.js'

test('SIWC exposes bounded socket retries through the registered provider policy', async t => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const adapter = new ChatGPTSiwcAdapter({
    connection: async () => ({ id: 'fixture', accessToken: 'synthetic-token' }),
    authorize: async () => {},
  })
  t.after(async () => { adapter.dispose(); await ctx.fiber.dispose() })
  ctx.llm.registerAdapter(['chatgpt-siwc'], adapter)
  const policy = ctx.llm.providerRetryPolicy('chatgpt-siwc')
  assert.equal(policy.mode, 'normal')
  if (policy.mode !== 'normal') assert.fail('Expected bounded normal retries')
  assert.equal(policy.maxRetries, 5)
  assert.equal(policy.initialDelayMs, 500)
  assert.equal(policy.maxDelayMs, 10_000)
  for (const code of ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'SIWC_SOCKET_INTERRUPTED']) {
    assert.ok(policy.retryableCodes.includes(code), code)
  }
  for (const code of ['AUTH', 'QUOTA', 'SIWC_INVALID_STREAM', 'SIWC_UNSUPPORTED_PARAMETER']) {
    assert.equal(policy.retryableCodes.includes(code), false, code)
  }
})

test('output interruption reaches DSH with a retryable failure and no in-stream replay', async t => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  t.after(async () => {
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') assert.fail('Fixture server address is unavailable')
  let sends = 0
  let httpCalls = 0
  server.on('connection', socket => socket.on('message', () => {
    sends++
    socket.send(JSON.stringify({
      type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Partial response',
    }), () => socket.close(1001))
  }))
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const adapter = new ChatGPTSiwcAdapter({
    connection: async () => ({ id: 'fixture', accessToken: 'synthetic-token' }),
    authorize: async () => {},
    socketFactory: async (headers, signal) => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}`, { headers })
      try { await once(socket, 'open', { signal }); return socket }
      catch (error) { socket.terminate(); throw error }
    },
    fetch: async url => {
      if (String(url).endsWith('/models')) return Response.json({
        models: [{ slug: 'fixture-model', display_name: 'Fixture', visibility: 'list' }],
      })
      httpCalls++
      throw new Error('Output interruption must be handed to DSH')
    },
  })
  t.after(async () => { adapter.dispose(); await ctx.fiber.dispose() })
  ctx.llm.registerAdapter(['chatgpt-siwc'], adapter)
  const config = { provider: 'chatgpt-siwc', model: 'fixture-model' }
  const prepared = await ctx.llm.prepareCall(config)
  const chunks: StreamChunk[] = []
  for await (const chunk of prepared.stream({
    ...config, sessionId: SessionId('fixture-session'),
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Fixture request' }] }],
  })) chunks.push(chunk)
  assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'Partial response'))
  const finish = chunks.at(-1)
  if (finish?.type !== 'finish' || finish.reason.kind !== 'error') assert.fail('Expected a DSH error finish')
  assert.equal(finish.reason.failure.code, 'SIWC_SOCKET_INTERRUPTED')
  const policy = prepared.retryPolicy
  if (policy.mode !== 'normal') assert.fail('Expected bounded normal retries')
  assert.ok(policy.retryableCodes.includes(finish.reason.failure.code))
  assert.equal(sends, 1)
  assert.equal(httpCalls, 0)
})
