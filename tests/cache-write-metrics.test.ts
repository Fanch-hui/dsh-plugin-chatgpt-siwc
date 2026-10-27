import assert from 'node:assert/strict'
import test from 'node:test'
import { exportDiagnosticsCsv, exportDiagnosticsJson, summarizeDiagnosticsRecords } from '../src/diagnostics/export.js'
import { RequestDiagnostics } from '../src/diagnostics/requests.js'
import { diagnosticSnapshotSchema } from '../src/diagnostics/schema.js'
import type { DiagnosticsSnapshot, RequestDiagnostic } from '../src/diagnostics/types.js'

function record(id: string, changes: Partial<RequestDiagnostic> = {}): RequestDiagnostic {
  return {
    id, startedAt: 1000, durationMs: 10, accountKey: 'a'.repeat(64), model: 'fixture',
    category: 'conversation', outcome: 'completed', sent: true,
    inputTokens: 100, cachedTokens: 30, outputTokens: 5,
    transport: [{mode: 'http', reason: 'independent-call'}], ...changes,
  }
}

test('cache write totals require complete observations for all sent requests', () => {
  const missing = record('missing')
  const ten = record('ten', {cacheWriteTokens: 10})
  const zero = record('zero', {cacheWriteTokens: 0})
  const unsent = record('unsent', {
    sent: false, inputTokens: undefined, cachedTokens: undefined, outputTokens: undefined,
    transport: [{mode: 'not-started', reason: 'not-started'}],
  })
  for (const [records, expected] of [
    [[missing], undefined],
    [[ten, missing], undefined],
    [[zero], 0],
    [[ten, zero], 10],
    [[ten, unsent], 10],
    [[ten, record('missing-read', {cachedTokens: undefined})], undefined],
    [[unsent], undefined],
  ] as const) {
    const {groups, metrics} = summarizeDiagnosticsRecords(records)
    assert.equal(groups[0].cacheWriteTokens, expected)
    assert.equal(metrics.cacheWriteTokens, expected)
  }
})

test('grouped and exported write totals remain unknown for incomplete samples', () => {
  const records = [
    record('known', {cacheWriteTokens: 10}),
    record('unknown'),
    record('other', {category: 'subagent', cacheWriteTokens: 0}),
  ]
  const {groups, reasons, metrics} = summarizeDiagnosticsRecords(records)
  const snapshot: DiagnosticsSnapshot = {retained: records.length, limit: 2000, groups, reasons, metrics, recent: records}
  const safe = diagnosticSnapshotSchema.parse(snapshot)
  const json = JSON.parse(exportDiagnosticsJson(safe))
  assert.equal(groups.find(group => group.category === 'conversation')?.cacheWriteTokens, undefined)
  assert.equal(groups.find(group => group.category === 'subagent')?.cacheWriteTokens, 0)
  assert.equal(metrics.cacheWriteTokens, undefined)
  assert.equal(metrics.otherInputTokens, undefined)
  assert.equal('cacheWriteTokens' in json.metrics, false)
  assert.equal('cacheWriteTokens' in json.snapshot.groups.find((group: {category: string}) => group.category === 'conversation'), false)
  assert.equal(json.snapshot.groups.find((group: {category: string}) => group.category === 'subagent').cacheWriteTokens, 0)
  assert.equal(JSON.parse(exportDiagnosticsJson(safe, {category: 'subagent'})).metrics.cacheWriteTokens, 0)
})

test('reported raw write tokens remain available when normalised usage has no write value', () => {
  const raw = record('raw', {metering: {
    usage: 'reported', cache: 'positive', reportedInputTokens: 100, reportedCachedTokens: 30,
    reportedOutputTokens: 5, reportedCacheWriteTokens: 20,
  }})
  const {groups, metrics} = summarizeDiagnosticsRecords([raw])
  assert.equal(groups[0].cacheWriteTokens, 20)
  assert.equal(metrics.cacheWriteTokens, 20)
  assert.equal(metrics.otherInputTokens, 50)
})

test('retries preserve unknown writes and deduplicate terminal usage', () => {
  for (const [firstWrite, secondWrite, expected] of [
    [undefined, 10, undefined], [10, undefined, undefined], [0, 0, 0], [10, 20, 30],
  ] as const) {
    const records: RequestDiagnostic[] = []
    const diagnostics = new RequestDiagnostics({record: value => records.push(value)}, () => 'conversation')
    const trace = diagnostics.begin({id: 'fixture', accessToken: 'fixture'},
      {provider: 'chatgpt-siwc', model: 'fixture', messages: []})
    for (const [index, write] of [firstWrite, secondWrite].entries()) {
      trace.timing('request-sent')
      const usage = {input_tokens: 100, output_tokens: 5,
        input_tokens_details: {cached_tokens: 30, ...(write === undefined ? {} : {cache_write_tokens: write})}}
      const event = {type: index === 0 ? 'response.failed' : 'response.completed',
        response: {id: `fixture-response-${index}`, usage}}
      const normalized = {inputTokens: 70 - (write ?? 0), cacheReadTokens: 30, outputTokens: 5,
        ...(write === undefined ? {} : {cacheWriteTokens: write})}
      trace.event(event)
      trace.usage(normalized)
      trace.event(event)
      trace.usage(normalized)
    }
    trace.finish('completed')
    const [item] = records
    const {groups, reasons, metrics} = summarizeDiagnosticsRecords(records)
    const snapshot = diagnosticSnapshotSchema.parse({retained: 1, limit: 2000, groups, reasons, metrics, recent: records})
    assert.equal(item.inputTokens, 200)
    assert.equal(item.cacheWriteTokens, expected)
    assert.equal(item.cacheWriteIncomplete, expected === undefined ? true : undefined)
    assert.equal(snapshot.groups[0].cacheWriteTokens, expected)
    assert.equal(snapshot.metrics?.cacheWriteTokens, expected)
    assert.equal(JSON.parse(exportDiagnosticsJson(snapshot)).metrics.cacheWriteTokens, expected)
    assert.equal(exportDiagnosticsCsv(snapshot).split('\n')[1].split(',')[9], expected === undefined ? '' : String(expected))
  }
})

test('a terminal response without usage keeps later retry totals unknown', () => {
  const records: RequestDiagnostic[] = []
  const diagnostics = new RequestDiagnostics({record: value => records.push(value)}, () => 'conversation')
  const trace = diagnostics.begin({id: 'fixture', accessToken: 'fixture'},
    {provider: 'chatgpt-siwc', model: 'fixture', messages: []})
  trace.timing('request-sent')
  trace.event({type: 'response.failed', response: {id: 'fixture-response-1'}})
  trace.timing('request-sent')
  trace.event({type: 'response.completed', response: {id: 'fixture-response-2', usage: {
    input_tokens: 100, output_tokens: 5, input_tokens_details: {cached_tokens: 30, cache_write_tokens: 10},
  }}})
  trace.usage({inputTokens: 60, cacheReadTokens: 30, cacheWriteTokens: 10, outputTokens: 5})
  trace.finish('completed')
  assert.equal(records[0].cacheWriteIncomplete, true)
  assert.equal(records[0].cacheWriteTokens, undefined)
  assert.equal(records[0].metering?.reportedCacheWriteTokens, 10)
  assert.equal(summarizeDiagnosticsRecords(records).metrics.cacheWriteTokens, undefined)
})
