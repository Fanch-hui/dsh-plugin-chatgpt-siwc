import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createDeveloperMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { ChatGPTSiwcAdapter } from '../src/provider/adapter.js'
import { toolIdentity } from '../src/provider/tools.js'

const alpha = { name: 'alpha', description: 'Alpha', parameters: { type: 'object', properties: {} } }
const beta = { name: 'beta', description: 'Beta', parameters: { type: 'object', properties: {} } }
const model = 'fixture-model'
const scope = 'fixture-scope'
type WireBody = { input: { type?: string }[]; tools: { tools: { name: string }[] }[] }

async function fixture(t: TestContext, toolAdditions: boolean | undefined, rejectAddition = false) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const bodies: WireBody[] = []
  const persisted: string[] = []
  const adapter = new ChatGPTSiwcAdapter({
    connection: async () => ({
      id: 'fixture-connection', replayScope: scope, accessToken: 'synthetic-token',
      cacheSettings: toolAdditions === undefined ? {} : { toolAdditions },
    }),
    authorize: async () => {},
    enhancements: toolAdditions ? { toolUpdate: 'addition-only' } : undefined,
    onCapability: (_model, capability, status) => { persisted.push(`${capability}:${status}`) },
    websocket: false,
    fetch: async (url, init) => {
      if (String(url).endsWith('/models')) {
        return Response.json({ models: [{ slug: model, display_name: 'Fixture', visibility: 'list' }] })
      }
      const body = JSON.parse(String(init?.body)) as WireBody
      bodies.push(body)
      const additionIndex = body.input.findIndex(item => item.type === 'additional_tools')
      if (rejectAddition && additionIndex >= 0) {
        return Response.json({ error: { code: 'unsupported_value', param: `input[${additionIndex}].type` } }, { status: 400 })
      }
      return new Response(`data: ${JSON.stringify({
        type: 'response.completed',
        response: { id: `fixture-response-${bodies.length}`, output: [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] },
        ] },
      })}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  ctx.llm.registerAdapter(['chatgpt-siwc'], adapter)
  t.after(async () => { adapter.dispose(); await ctx.fiber.dispose() })
  const dev = createDeveloperMessage({ source: { kind: 'user' }, content: [{ type: 'tool-addition', toolName: 'beta' }] })
  const options: GenerateOptions = {
    provider: 'chatgpt-siwc', model, tools: [alpha, beta],
    toolHistory: { tools: [alpha], updates: [{ messageId: dev.id, additions: [beta] }] },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Use the available tools' }] }, dev],
  }
  const run = async () => {
    const chunks = []
    for await (const chunk of ctx.llm.stream(options)) chunks.push(chunk)
    const last = chunks.at(-1)
    assert.equal(last?.type, 'finish')
    assert.deepEqual(last?.type === 'finish' && last.reason, { kind: 'stop' })
  }
  return { adapter, bodies, persisted, run }
}

test('enabled tool additions are first probed through real DSH dispatch and become supported', async t => {
  const { adapter, bodies, persisted, run } = await fixture(t, true)
  assert.equal(adapter.capabilities.status(scope, model, 'additional_tools'), 'unknown')
  await run()
  assert.equal(bodies.length, 1)
  assert.deepEqual(bodies[0].tools[0].tools.map(tool => tool.name), [toolIdentity('alpha').name])
  const addition = bodies[0].input.find(item => item.type === 'additional_tools')
  assert.deepEqual((addition as { tools?: { tools: { name: string }[] }[] })?.tools?.[0].tools.map(tool => tool.name), [toolIdentity('beta').name])
  assert.equal(adapter.capabilities.status(scope, model, 'additional_tools'), 'supported')
  assert.deepEqual(persisted, ['additional_tools:supported'])
  await run()
  assert.ok(bodies[1].input.some(item => item.type === 'additional_tools'))
  assert.deepEqual(persisted, ['additional_tools:supported'])
})

test('rejected first tool probe retries with all active tools and disables future probes', async t => {
  const { adapter, bodies, persisted, run } = await fixture(t, true, true)
  await run()
  assert.equal(bodies.length, 2)
  assert.ok(bodies[0].input.some(item => item.type === 'additional_tools'))
  assert.equal(bodies[1].input.some(item => item.type === 'additional_tools'), false)
  assert.deepEqual(bodies[1].tools[0].tools.map(tool => tool.name), [toolIdentity('alpha').name, toolIdentity('beta').name])
  assert.equal(adapter.capabilities.status(scope, model, 'additional_tools'), 'unsupported')
  assert.equal((await adapter.resolveModel('chatgpt-siwc', model)).toolUpdate, undefined)
  assert.deepEqual(persisted, ['additional_tools:unsupported'])
  await run()
  assert.equal(bodies.length, 3)
  assert.equal(bodies[2].input.some(item => item.type === 'additional_tools'), false)
  assert.deepEqual(bodies[2].tools[0].tools.map(tool => tool.name), [toolIdentity('alpha').name, toolIdentity('beta').name])
})

for (const enabled of [false, undefined]) {
  test(`tool addition setting ${String(enabled)} retains complete declarations without probing`, async t => {
    const { adapter, bodies, persisted, run } = await fixture(t, enabled)
    await run()
    assert.equal(bodies.length, 1)
    assert.equal(bodies[0].input.some(item => item.type === 'additional_tools'), false)
    assert.deepEqual(bodies[0].tools[0].tools.map(tool => tool.name), [toolIdentity('alpha').name, toolIdentity('beta').name])
    assert.equal(adapter.capabilities.status(scope, model, 'additional_tools'), 'unknown')
    assert.deepEqual(persisted, [])
  })
}
