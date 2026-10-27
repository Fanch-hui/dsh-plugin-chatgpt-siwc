import test from 'node:test'
import assert from 'node:assert/strict'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SiwcStatus } from '../src/api/types.js'
import type { DiagnosticsFilter, DiagnosticsSnapshot } from '../src/diagnostics/types.js'
import { SiwcController, type RemoteFace } from '../src/client/controller.js'

const initial: SiwcStatus = {authenticated: true, activeAccountId: 'fixture-a', signingIn: false, planEnabled: true,
  availability: 'ready', accounts: [], models: [], authorizedSessions: [], allowBackground: true,
  usage: {requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0}}
const value = <T>(result: T): RemoteResult<T> => ({ok: true, value: result})
function deferred<T = SiwcStatus>() {
  let resolve!: (value: RemoteResult<T>) => void
  const promise = new Promise<RemoteResult<T>>(finish => { resolve = finish })
  return {promise, resolve}
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve))

test('quota and model reads keep account controls usable and preserve the visible snapshot', async t => {
  const quota = deferred()
  const models = deferred()
  let settingsCalls = 0
  const controller = new SiwcController({
    async status() { return value(initial) },
    refreshQuota() { return quota.promise },
    refreshModels() { return models.promise },
    async setBackgroundAllowed() { settingsCalls++; return value({...initial, allowBackground: false}) },
  } as unknown as RemoteFace)
  t.after(() => controller.dispose())
  await controller.run('status')
  const readingQuota = controller.run('refreshQuota')
  const readingModels = controller.run('refreshModels')
  assert.equal(controller.getSnapshot().pending, undefined)
  assert.equal(controller.getSnapshot().quotaPending, true)
  assert.equal(controller.getSnapshot().modelsPending, true)
  assert.equal(controller.getSnapshot().status, initial)
  await controller.run('setBackgroundAllowed', false)
  assert.equal(settingsCalls, 1)
  quota.resolve(value(initial))
  models.resolve(value(initial))
  await Promise.all([readingQuota, readingModels])
  assert.equal(controller.getSnapshot().status?.allowBackground, false)
  assert.equal(controller.getSnapshot().quotaPending, false)
  assert.equal(controller.getSnapshot().modelsPending, false)
})

test('a delayed read cannot restore a previously active account after switching', async t => {
  const quota = deferred()
  const statusRead = deferred()
  let reads = 0
  const controller = new SiwcController({
    status() { return ++reads === 1 ? Promise.resolve(value(initial)) : statusRead.promise },
    refreshQuota() { return quota.promise },
    async switchAccount() { return value({...initial, activeAccountId: 'fixture-b'}) },
  } as unknown as RemoteFace)
  t.after(() => controller.dispose())
  await controller.run('status')
  const readingQuota = controller.run('refreshQuota')
  const readingStatus = controller.run('status')
  await controller.run('switchAccount', 'fixture-b')
  quota.resolve(value(initial))
  statusRead.resolve(value(initial))
  await Promise.all([readingQuota, readingStatus])
  assert.equal(controller.getSnapshot().status?.activeAccountId, 'fixture-b')
})

test('concurrent reads of the same source share one remote request', async t => {
  const quota = deferred()
  let calls = 0
  const controller = new SiwcController({
    async status() { return value(initial) },
    refreshQuota() { calls++; return quota.promise },
  } as unknown as RemoteFace)
  t.after(() => controller.dispose())
  await controller.run('status')
  const one = controller.run('refreshQuota')
  const two = controller.run('refreshQuota')
  await settle()
  assert.equal(calls, 1)
  quota.resolve(value(initial))
  await Promise.all([one, two])
})

test('a status read preserves quota and models refreshed while that read was in flight', async t => {
  const statusRead = deferred()
  const newQuota = {current: {source: 'linked-codex' as const, state: 'ready' as const, snapshot: {updatedAt: 42, buckets: []}}, codex: {state: 'disconnected' as const}}
  const newModels = [{id: 'fixture-new', name: 'Fixture new', verified: true}]
  let calls = 0
  const controller = new SiwcController({
    status() { return ++calls === 1 ? Promise.resolve(value(initial)) : statusRead.promise },
    async refreshQuota() { return value({...initial, quota: newQuota}) },
    async refreshModels() { return value({...initial, models: newModels}) },
  } as unknown as RemoteFace)
  t.after(() => controller.dispose())
  await controller.run('status')
  const readingStatus = controller.run('status')
  await Promise.all([controller.run('refreshQuota'), controller.run('refreshModels')])
  statusRead.resolve(value(initial))
  await readingStatus
  assert.deepEqual(controller.getSnapshot().status?.quota, newQuota)
  assert.deepEqual(controller.getSnapshot().status?.models, newModels)
})

test('read errors remain local and a failed mutation still rejects preceding read results', async t => {
  const quota = deferred()
  const controller = new SiwcController({
    async status() { return value(initial) },
    refreshQuota() { return quota.promise },
    async refreshModels() { throw new Error('Fixture transport failure') },
    async setBackgroundAllowed() { return {ok: false, error: {message: 'Fixture mutation failure'}} },
  } as unknown as RemoteFace)
  t.after(() => controller.dispose())
  await controller.run('status')
  const readingQuota = controller.run('refreshQuota')
  await controller.run('refreshModels')
  assert.equal(controller.getSnapshot().modelsError, '连接 DSH 服务失败，请重试。')
  assert.equal(controller.getSnapshot().error, undefined)
  await controller.run('setBackgroundAllowed', false)
  quota.resolve(value({...initial, allowBackground: false}))
  await readingQuota
  assert.equal(controller.getSnapshot().status?.allowBackground, true)
  assert.equal(controller.getSnapshot().error, 'Fixture mutation failure')
})

test('external account changes reject the former account quota and model reads', async t => {
  const quota = deferred()
  const models = deferred()
  const current = {...initial, activeAccountId: 'fixture-b', models: [{id: 'fixture-b-model', name: 'B model'}]}
  let calls = 0
  const controller = new SiwcController({
    async status() { return value(++calls === 1 ? initial : current) },
    refreshQuota() { return quota.promise },
    refreshModels() { return models.promise },
  } as unknown as RemoteFace)
  t.after(() => controller.dispose())
  await controller.run('status')
  const readingQuota = controller.run('refreshQuota')
  const readingModels = controller.run('refreshModels')
  await controller.run('status')
  quota.resolve(value({...initial, quota: {current: {source: 'linked-codex', state: 'ready', snapshot: {updatedAt: 1, buckets: []}}, codex: {state: 'disconnected'}}}))
  models.resolve(value({...initial, models: [{id: 'fixture-a-model', name: 'A model'}]}))
  await Promise.all([readingQuota, readingModels])
  assert.equal(controller.getSnapshot().status?.activeAccountId, 'fixture-b')
  assert.equal(controller.getSnapshot().status?.quota, undefined)
  assert.deepEqual(controller.getSnapshot().status?.models, current.models)
})

test('an external account status replaces all account fields even when old account reads just refreshed', async t => {
  const statusRead = deferred()
  const quotaB = {current: {source: 'linked-codex' as const, state: 'ready' as const, snapshot: {updatedAt: 2, buckets: []}}, codex: {state: 'disconnected' as const}}
  const modelsB = [{id: 'fixture-b-model', name: 'B model'}]
  let calls = 0
  const controller = new SiwcController({
    status() { return ++calls === 1 ? Promise.resolve(value(initial)) : statusRead.promise },
    async refreshQuota() { return value({...initial, quota: {codex: {state: 'disconnected'}}}) },
    async refreshModels() { return value({...initial, models: [{id: 'fixture-a-model', name: 'A model'}]}) },
  } as unknown as RemoteFace)
  t.after(() => controller.dispose())
  await controller.run('status')
  const readingStatus = controller.run('status')
  await Promise.all([controller.run('refreshQuota'), controller.run('refreshModels')])
  statusRead.resolve(value({...initial, activeAccountId: 'fixture-b', quota: quotaB, models: modelsB}))
  await readingStatus
  assert.equal(controller.getSnapshot().status?.activeAccountId, 'fixture-b')
  assert.deepEqual(controller.getSnapshot().status?.quota, quotaB)
  assert.deepEqual(controller.getSnapshot().status?.models, modelsB)
})

test('diagnostic queries pass filters and results without replacing account state changed in flight', async t => {
  const query = deferred<DiagnosticsSnapshot>()
  const filter: DiagnosticsFilter = {category: 'conversation', model: 'fixture-query-model', reason: 'continued'}
  const diagnostics: DiagnosticsSnapshot = {retained: 0, limit: 2000, groups: [], reasons: [],
    recent: [], records: [], models: [],
    metrics: {totalInputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, missingCacheSamples: 0}}
  const current = {...initial, activeAccountId: 'fixture-b', allowBackground: false}
  let received: DiagnosticsFilter | undefined
  const controller = new SiwcController({
    async status() { return value(initial) },
    queryDiagnostics(next: DiagnosticsFilter) { received = next; return query.promise },
    async switchAccount() { return value(current) },
  } as unknown as RemoteFace)
  t.after(() => controller.dispose())
  await controller.run('status')
  const before = controller.getSnapshot()
  const reading = controller.queryDiagnostics(filter)
  assert.equal(received, filter)
  assert.equal(controller.getSnapshot(), before)
  await controller.run('switchAccount', 'fixture-b')
  const switched = controller.getSnapshot()
  query.resolve(value(diagnostics))
  assert.equal(await reading, diagnostics)
  assert.equal(controller.getSnapshot(), switched)
  assert.equal(controller.getSnapshot().status, current)
})

test('diagnostic query Remote errors reject without overwriting account state', async t => {
  const controller = new SiwcController({
    async status() { return value(initial) },
    async queryDiagnostics() { return {ok: false, error: {message: 'Fixture diagnostic query failure'}} },
  } as unknown as RemoteFace)
  t.after(() => controller.dispose())
  await controller.run('status')
  const before = controller.getSnapshot()
  await assert.rejects(controller.queryDiagnostics({}), {message: 'Fixture diagnostic query failure'})
  assert.equal(controller.getSnapshot(), before)
})

test('diagnostic query transport failures propagate without overwriting account state', async t => {
  const failure = new Error('Fixture diagnostic transport failure')
  const controller = new SiwcController({
    async status() { return value(initial) },
    async queryDiagnostics() { throw failure },
  } as unknown as RemoteFace)
  t.after(() => controller.dispose())
  await controller.run('status')
  const before = controller.getSnapshot()
  await assert.rejects(controller.queryDiagnostics({}), error => error === failure)
  assert.equal(controller.getSnapshot(), before)
})

function selectedQuota(id: string) {
  return {selectedAccountId: id, accounts: [{id, state: 'ready' as const, sourceKey: id}],
    codex: {state: 'ready' as const, sourceKey: id}}
}

test('switching the selected quota account discards an earlier quota refresh', async t => {
  const previous = deferred()
  const a = {...initial, quota: selectedQuota('quota-a')}
  const b = {...initial, quota: selectedQuota('quota-b')}
  let selected: string | undefined
  const controller = new SiwcController({
    async status() { return value(a) },
    refreshQuota() { return previous.promise },
    async selectCodexQuota(id: string) { selected = id; return value(b) },
  } as unknown as RemoteFace)
  t.after(() => controller.dispose())
  await controller.run('status')
  const reading = controller.run('refreshQuota')
  await controller.run('selectCodexQuota', 'quota-b')
  previous.resolve(value(a))
  await reading
  assert.equal(selected, 'quota-b')
  assert.deepEqual(controller.getSnapshot().status?.quota, b.quota)
})

test('a quota refresh for an externally changed source cannot restore the previous source', async t => {
  const previous = deferred()
  const a = {...initial, quota: selectedQuota('quota-a')}
  const b = {...initial, quota: selectedQuota('quota-b')}
  let reads = 0
  const controller = new SiwcController({
    async status() { return value(++reads === 1 ? a : b) },
    refreshQuota() { return previous.promise },
  } as unknown as RemoteFace)
  t.after(() => controller.dispose())
  await controller.run('status')
  const reading = controller.run('refreshQuota')
  await controller.run('status')
  previous.resolve(value(a))
  await reading
  assert.deepEqual(controller.getSnapshot().status?.quota, b.quota)
})
