import test from 'node:test'
import assert from 'node:assert/strict'
import { ChatGPTSiwcAdapter, type ProviderConnection } from '../src/provider/adapter.js'

const first: ProviderConnection = {id: 'fixture-first:1', accountId: 'fixture-first', accessToken: 'fixture-access'}
function fixture() {
  let selected = first
  let catalogRequests = 0
  const overrides = new Map<string, number>()
  const calls: {account: string | undefined; model: string; defaultWindow: number | undefined}[] = []
  const adapter = new ChatGPTSiwcAdapter({
    connection: async () => selected,
    authorize: async () => {},
    contextWindow: async (connection, model) => {
      calls.push({account: connection.accountId, model: model.id, defaultWindow: model.context?.contextWindow})
      return overrides.get(connection.accountId!)
    },
    fetch: async input => {
      assert.ok(String(input).endsWith('/models'))
      catalogRequests++
      return Response.json({models: [{slug: 'fixture-model', display_name: 'Fixture model', visibility: 'list',
        context_window: 128_000, max_context_window: 256_000}]})
    },
  })
  return {adapter, overrides, calls, select(value: ProviderConnection) {selected = value}, requests: () => catalogRequests}
}

test('resolved and prepared calls use current overrides while catalog and restored defaults stay intact', async () => {
  const {adapter, overrides, calls, requests} = fixture()
  try {
    const catalog = await adapter.refreshModels()
    assert.equal(catalog[0].context?.contextWindow, 128_000)
    assert.equal(catalog[0].maxContextWindow, 256_000)
    overrides.set(first.accountId!, 192_000)
    assert.equal((await adapter.resolveModel('chatgpt-siwc', 'fixture-model')).context?.contextWindow, 192_000)
    assert.equal((await adapter.prepareCall('chatgpt-siwc', 'fixture-model')).model.context?.contextWindow, 192_000)
    assert.equal(catalog[0].context?.contextWindow, 128_000)
    assert.ok(calls.every(call => call.defaultWindow === 128_000 && call.model === 'fixture-model'))
    assert.equal(requests(), 1)
    overrides.delete(first.accountId!)
    assert.equal((await adapter.resolveModel('chatgpt-siwc', 'fixture-model')).context?.contextWindow, 128_000)
    assert.equal((await adapter.prepareCall('chatgpt-siwc', 'fixture-model')).model.context?.contextWindow, 128_000)
  } finally {adapter.dispose()}
})

test('context callbacks receive the selected account on every model resolution', async () => {
  const value = fixture()
  try {
    value.overrides.set(first.accountId!, 192_000)
    assert.equal((await value.adapter.resolveModel('chatgpt-siwc', 'fixture-model')).context?.contextWindow, 192_000)
    value.select({id: 'fixture-second:1', accountId: 'fixture-second', accessToken: 'fixture-second-access'})
    assert.equal((await value.adapter.prepareCall('chatgpt-siwc', 'fixture-model')).model.context?.contextWindow, 128_000)
    value.overrides.set('fixture-second', 96_000)
    assert.equal((await value.adapter.resolveModel('chatgpt-siwc', 'fixture-model')).context?.contextWindow, 96_000)
    assert.deepEqual(value.calls.map(call => call.account), ['fixture-first', 'fixture-second', 'fixture-second'])
  } finally {value.adapter.dispose()}
})

test('invalid and over-capacity context overrides are rejected before a call is prepared', async () => {
  const {adapter, overrides} = fixture()
  try {
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 256_001]) {
      overrides.set(first.accountId!, invalid)
      await assert.rejects(adapter.prepareCall('chatgpt-siwc', 'fixture-model'), {code: 'SIWC_INVALID_CONTEXT_WINDOW'})
    }
  } finally {adapter.dispose()}
})
