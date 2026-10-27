import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  exportDiagnosticsCsv,
  exportDiagnosticsJson,
  filterDiagnosticsRecords,
  findReconnectBaseline,
  recordOtherInputTokens,
  summarizeDiagnosticsRecords,
  unifiedMetrics,
} from '../src/diagnostics/export.js'
import { DiagnosticsStore } from '../src/diagnostics/store.js'
import { diagnosticSnapshotSchema } from '../src/diagnostics/schema.js'
import type { RequestDiagnostic } from '../src/diagnostics/types.js'

function record(index: number, changes: Partial<RequestDiagnostic> = {}): RequestDiagnostic {
  return {id: `fixture-${index}`, startedAt: 1000 + index, durationMs: 25,
    accountKey: 'a'.repeat(64), sessionKey: 'b'.repeat(64), model: 'fixture-model', category: 'conversation',
    outcome: 'completed', inputTokens: 100, cachedTokens: 70, outputTokens: 10,
    transport: [{mode: 'ws-full', reason: 'cold-connection'}], ...changes}
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-diagnostics-test-'))
  const store = new DiagnosticsStore(root)
  return {root, store, filename: join(root, 'chatgpt-siwc-diagnostics.json'),
    async close() { await store.dispose(); await rm(root, {recursive: true, force: true}) }}
}

test('diagnostics persist owner-only projected records and aggregate measured usage independently of missing counters', async () => {
  const value = await fixture()
  try {
    const unsafe = {...record(1), accessToken: 'fixture-secret', body: 'fixture-private-body',
      transport: [{mode: 'ws-full', reason: 'cold-connection', authorization: 'fixture-authorization'}]}
    value.store.record(unsafe as RequestDiagnostic)
    value.store.record(record(2, {inputTokens: undefined, cachedTokens: undefined, outputTokens: undefined, outcome: 'cancelled',
      transport: [{mode: 'ws-full', reason: 'cold-connection'}, {mode: 'http-fallback', reason: 'cold-connection'}]}))
    await value.store.dispose()
    const text = await readFile(value.filename, 'utf8')
    assert.equal(text.includes('fixture-secret'), false)
    assert.equal(text.includes('fixture-private-body'), false)
    assert.equal(text.includes('fixture-authorization'), false)
    if (process.platform !== 'win32') assert.equal((await stat(value.filename)).mode & 0o777, 0o600)
    const restarted = new DiagnosticsStore(value.root)
    const snapshot = diagnosticSnapshotSchema.parse(await restarted.snapshot())
    assert.equal(snapshot.retained, 2)
    assert.equal(snapshot.since, 1001)
    assert.deepEqual(snapshot.groups, [{category: 'conversation', requests: 2, measuredRequests: 1, failed: 1,
      inputTokens: 100, cachedTokens: 70, outputTokens: 10, durationMs: 50}])
    assert.deepEqual(snapshot.reasons, [{reason: 'cold-connection', requests: 2}])
    assert.deepEqual(snapshot.recent.map(record => record.id), ['fixture-2', 'fixture-1'])
    await restarted.dispose()
  } finally { await value.close() }
})

test('diagnostics keep the newest 2000 records and only 30 recent entries in the remote snapshot', async () => {
  const value = await fixture()
  try {
    for (let index = 0; index < 2005; index++) value.store.record(record(index))
    const snapshot = await value.store.snapshot()
    assert.equal(snapshot.retained, 2000)
    assert.equal(snapshot.recent.length, 30)
    assert.equal(snapshot.since, 1005)
    assert.equal(snapshot.groups[0].requests, 2000)
    const persisted = JSON.parse(await readFile(value.filename, 'utf8'))
    assert.equal(persisted.records.length, 2000)
    assert.equal(persisted.records[0].id, 'fixture-5')
  } finally { await value.close() }
})

test('simultaneous stores append under the Host lock without overwriting another writer', async () => {
  const value = await fixture()
  const other = new DiagnosticsStore(value.root)
  try {
    value.store.record(record(1))
    other.record(record(2))
    await Promise.all([value.store.dispose(), other.dispose()])
    assert.deepEqual((await value.store.snapshot()).recent.map(record => record.id), ['fixture-2', 'fixture-1'])
  } finally { await other.dispose(); await value.close() }
})

test('full diagnostic queries and exports include matches older than the recent list', async () => {
  const value = await fixture()
  try {
    const samples = Array.from({length: 40}, (_, index) => record(index, index < 10
      ? {model: 'older-model', category: 'subagent', cachedTokens: 0, transport: [{mode: 'http', reason: 'websocket-disabled'}]}
      : {model: 'recent-model', cachedTokens: 90}))
    await writeFile(value.filename, JSON.stringify({version: 1, records: samples}))

    const overview = diagnosticSnapshotSchema.parse(await value.store.snapshot())
    assert.equal(overview.retained, 40)
    assert.equal(overview.recent.length, 30)
    assert.equal(overview.records, undefined)
    assert.deepEqual(overview.models, ['older-model', 'recent-model'])
    assert.equal(overview.metrics?.totalInputTokens, 4000)
    assert.equal(overview.metrics?.cacheReadRate, 0.675)

    const full = diagnosticSnapshotSchema.parse(await value.store.query())
    assert.equal(full.records?.length, 40)
    assert.equal(full.recent.length, 30)
    assert.equal(full.metrics?.totalInputTokens, 4000)
    const fullJson = JSON.parse(exportDiagnosticsJson(full))
    assert.equal(fullJson.snapshot.records.length, 40)
    assert.equal(fullJson.snapshot.recent.length, 30)
    assert.equal(fullJson.metrics.totalInputTokens, 4000)
    assert.deepEqual(fullJson.timeRange, {since: 1000, until: 1064})
    assert.equal(exportDiagnosticsCsv(full).split('\n').length, 41)

    const filter = {category: 'subagent' as const, model: 'older-model', reason: 'websocket-disabled'}
    const selected = diagnosticSnapshotSchema.parse(await value.store.query(filter))
    assert.equal(selected.retained, 10)
    assert.equal(selected.records?.length, 10)
    assert.equal(selected.groups[0].requests, 10)
    assert.deepEqual(selected.reasons, [{reason: 'websocket-disabled', requests: 10}])
    assert.equal(selected.metrics?.cacheReadRate, 0)
    assert.equal(selected.metrics?.totalInputTokens, 1000)
    const filteredJson = JSON.parse(exportDiagnosticsJson(full, filter))
    assert.deepEqual(filteredJson.snapshot.records, selected.records)
    assert.deepEqual(filteredJson.metrics, selected.metrics)
    assert.equal(exportDiagnosticsCsv(full, filter), exportDiagnosticsCsv(selected))
    assert.equal(exportDiagnosticsCsv(selected).split('\n').length, 11)
  } finally { await value.close() }
})

test('invalid or oversized storage stays intact while diagnostics remain available for this process', async () => {
  const value = await fixture()
  try {
    const original = '{"version":1,"records":["fixture-invalid-record"]}'
    await writeFile(value.filename, original)
    value.store.record(record(1))
    const snapshot = await value.store.snapshot()
    assert.match(snapshot.storageError!, /读取失败/)
    assert.equal(snapshot.retained, 1)
    assert.equal(await readFile(value.filename, 'utf8'), original)
    value.store.record(record(2))
    assert.equal((await value.store.snapshot()).retained, 2)
    assert.equal(await readFile(value.filename, 'utf8'), original)
    const largeRoot = await mkdtemp(join(tmpdir(), 'dsh-diagnostics-large-'))
    try {
      await writeFile(join(largeRoot, 'chatgpt-siwc-diagnostics.json'), 'x'.repeat(8 * 1024 * 1024 + 1))
      const large = new DiagnosticsStore(largeRoot)
      assert.match((await large.snapshot()).storageError!, /读取失败/)
      await large.dispose()
    } finally { await rm(largeRoot, {recursive: true, force: true}) }
  } finally { await value.close() }
})

test('invalid diagnostic records never throw or persist and write failures are reported', async () => {
  const value = await fixture()
  try {
    assert.doesNotThrow(() => value.store.record(record(1, {accountKey: 'fixture-raw-account'})))
    const invalid = await value.store.snapshot()
    assert.equal(invalid.retained, 0)
    assert.match(invalid.storageError!, /格式无效/)
    const blocked = join(value.root, 'not-a-directory')
    await writeFile(blocked, 'fixture-existing-file')
    const store = new DiagnosticsStore(blocked)
    store.record(record(2))
    const snapshot = await store.snapshot()
    assert.equal(snapshot.retained, 1)
    assert.match(snapshot.storageError!, /读取失败|保存失败/)
    await store.dispose()
  } finally { await value.close() }
})

test('cache aggregates exclude unknown cache counts while counting explicit zero hits', async () => {
  const value = await fixture()
  try {
    value.store.record(record(1, {inputTokens: 900, cachedTokens: undefined}))
    value.store.record(record(2, {cachedTokens: 0}))
    value.store.record(record(3))
    const group = (await value.store.snapshot()).groups[0]
    assert.equal(group.requests, 3)
    assert.equal(group.measuredRequests, 2)
    assert.equal(group.inputTokens, 200)
    assert.equal(group.cachedTokens, 70)
  } finally { await value.close() }
})

test('extended diagnostic evidence survives storage while unknown nested fields are stripped', async () => {
  const value = await fixture()
  try {
    value.store.record({...record(9), runtimeId: '12345678-1234-4234-8234-123456789012',
      metering: {usage: 'reported', cache: 'zero', reportedInputTokens: 100, reportedCachedTokens: 0, reportedOutputTokens: 10, body: 'private-body'},
      routing: {wireSessionHash: 'c'.repeat(64), connectionHash: 'd'.repeat(64), previousGapMs: 1000, accessToken: 'private-token'},
      server: {model: 'fixture-model', status: 'completed', responseIdHash: 'e'.repeat(64), headers: 'private-header'},
      durability: {reason: 'confirmed', candidates: 1, confirmed: 1},
      request: {inputItems: 3, toolCount: 2, cacheKeyPresent: false},
      transport: [{mode: 'ws-full', reason: 'cold-connection', connection: {state: 'new', cause: 'remote-closed', closeCode: 1006, reason: 'private-close'}}],
    } as unknown as RequestDiagnostic)
    const snapshot = await value.store.snapshot()
    assert.equal(snapshot.recent[0].metering?.cache, 'zero')
    assert.equal(snapshot.recent[0].transport[0].connection?.cause, 'remote-closed')
    assert.equal(snapshot.recent[0].durability?.confirmed, 1)
    const serialized = await readFile(value.filename, 'utf8')
    assert.equal(serialized.includes('private-'), false)
  } finally { await value.close() }
})

test('unified metrics, cacheWriteTokens group sum, and JSON/CSV exports follow Section 1 rules', async () => {
  const value = await fixture()
  try {
    const r1 = record(1, {inputTokens: 15000, cachedTokens: 10000, cacheWriteTokens: 3000, outputTokens: 100})
    const r2 = record(2, {inputTokens: 5000, cachedTokens: undefined, outputTokens: 50})
    const r3 = record(3, {inputTokens: undefined, cachedTokens: undefined, transport: [{mode: 'not-started', reason: 'not-started'}]})
    value.store.record(r1)
    value.store.record(r2)
    value.store.record(r3)
    const snapshot = await value.store.snapshot()
    assert.equal(snapshot.groups[0].cacheWriteTokens, undefined)

    const metrics = unifiedMetrics(snapshot.recent)
    assert.equal(metrics.totalInputTokens, 15000)
    assert.equal(metrics.cachedTokens, 10000)
    assert.equal(metrics.cacheWriteTokens, undefined)
    assert.equal(metrics.otherInputTokens, undefined)
    assert.equal(metrics.missingCacheSamples, 1)
    assert.ok(Math.abs((metrics.cacheReadRate ?? 0) - 10000 / 15000) < 1e-6)
    assert.equal(metrics.meteringCoverageRate, 0.5)
    assert.equal(recordOtherInputTokens(r1), 2000)
    assert.equal(recordOtherInputTokens(r2), undefined)

    const json = JSON.parse(exportDiagnosticsJson(snapshot))
    assert.equal(json.schemaVersion, 1)
    assert.equal(json.metrics.otherInputTokens, undefined)
    const csv = exportDiagnosticsCsv(snapshot)
    assert.match(csv, /schemaVersion,id,startedAt/)
    assert.match(csv, /fixture-1,1001,conversation,fixture-model,completed,25,15000,10000,3000,2000,100/)

    // Filtered query/export and reconnect baseline lookup
    const r4 = record(4, {category: 'subagent', model: 'sub-model', baselineRequestId: 'fixture-1'})
    value.store.record(r4)
    const filteredSnapshot = await value.store.snapshot({category: 'subagent'})
    assert.equal(filteredSnapshot.retained, 1)
    assert.equal(filteredSnapshot.groups.length, 1)
    assert.equal(filteredSnapshot.groups[0].category, 'subagent')
    const allSnapshot = await value.store.snapshot()
    const filteredRecent = filterDiagnosticsRecords(allSnapshot.recent, {category: 'subagent'})
    assert.equal(summarizeDiagnosticsRecords(filteredRecent).groups[0].requests, 1)
    const filteredJson = JSON.parse(exportDiagnosticsJson(allSnapshot, {category: 'subagent'}))
    assert.equal(filteredJson.snapshot.recent.length, 1)
    assert.equal(findReconnectBaseline(r4, allSnapshot.recent)?.id, 'fixture-1')
    assert.equal(findReconnectBaseline(r1, [r1]), undefined)
    assert.equal(findReconnectBaseline(r2, [r3, r2, r1])?.id, 'fixture-1')
  } finally { await value.close() }
})
