import test from 'node:test'
import assert from 'node:assert/strict'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RequestDiagnostics } from '../src/diagnostics/requests.js'
import type { RequestDiagnostic } from '../src/diagnostics/types.js'

const connection = {id: 'private-connection-a', accountId: 'private-account-a', accessToken: 'private-access-a'}
const options = {provider: 'chatgpt-siwc', model: 'fixture-model', sessionId: SessionId('private-session'), messages: []}
function fixture() {
  const records: RequestDiagnostic[] = []
  const diagnostics = new RequestDiagnostics({record(value) { records.push(value) }}, () => 'conversation')
  return {records, diagnostics}
}

test('raw usage distinguishes missing, invalid and explicitly reported cache accounting', () => {
  const {records, diagnostics} = fixture()
  const usages = [undefined, null, {input_tokens: 100, output_tokens: 5},
    {input_tokens: 100, output_tokens: 5, input_tokens_details: {cached_tokens: 0}},
    {input_tokens: 100, output_tokens: 5, input_tokens_details: {cached_tokens: 70, cache_write_tokens: 30}},
    {input_tokens: Infinity, output_tokens: NaN, input_tokens_details: {cached_tokens: -1}},
    {input_tokens: 100, output_tokens: 5, input_tokens_details: {cached_tokens: 101}},
    {input_tokens: 100, output_tokens: 5, input_tokens_details: 'invalid'},
  ]
  for (const usage of usages) {
    const trace = diagnostics.begin(connection, options)
    trace.event({type: 'response.completed', response: {usage}})
    trace.finish('completed')
  }
  assert.deepEqual(records.map(record => [record.metering?.usage, record.metering?.cache]), [
    ['missing', 'missing'], ['invalid', 'missing'], ['reported', 'missing'], ['reported', 'zero'],
    ['reported', 'positive'], ['invalid', 'invalid'], ['invalid', 'invalid'], ['invalid', 'invalid'],
  ])
  assert.deepEqual(records[4].metering, {usage: 'reported', cache: 'positive', reportedInputTokens: 100,
    reportedOutputTokens: 5, reportedCachedTokens: 70, reportedCacheWriteTokens: 30})
  assert.equal(records[5].metering?.reportedInputTokens, undefined)
  assert.equal(records[5].metering?.reportedCachedTokens, undefined)
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(records)))
})

test('routing identifies changes across accounts, connections and models while ignoring renewed access tokens', t => {
  t.mock.timers.enable({apis: ['Date'], now: 1_000})
  const {records, diagnostics} = fixture()
  const run = (account: string, id: string, model: string, wire: string, accessToken = 'private-access-a') => {
    const trace = diagnostics.begin({accountId: account, id, accessToken}, {...options, model})
    trace.wireSession(wire)
    trace.finish('completed')
  }
  run('private-account-a', 'private-connection-a', 'fixture-model', 'private-wire-a')
  t.mock.timers.tick(2_000)
  run('private-account-a', 'private-connection-a', 'fixture-model', 'private-wire-a', 'private-access-b')
  t.mock.timers.tick(3_000)
  run('private-account-b', 'private-connection-b', 'fixture-other', 'private-wire-b')
  assert.equal(records[0].routing?.previousGapMs, undefined)
  assert.deepEqual(records[1].routing, {...records[0].routing, previousGapMs: 2_000,
    accountChanged: false, connectionChanged: false, modelChanged: false, wireSessionChanged: false})
  assert.equal(records[2].routing?.previousGapMs, 3_000)
  for (const field of ['accountChanged', 'connectionChanged', 'modelChanged', 'wireSessionChanged'] as const) {
    assert.equal(records[2].routing?.[field], true)
  }
  assert.equal(records[0].runtimeId, records[2].runtimeId)
  const serialized = JSON.stringify(records)
  assert.equal(serialized.includes('private-'), false)
})

test('runtime identity changes with a fresh observer and routing baselines remain bounded', () => {
  const first = fixture()
  const second = fixture()
  first.diagnostics.begin(connection, options).finish('completed')
  second.diagnostics.begin(connection, options).finish('completed')
  assert.notEqual(first.records[0].runtimeId, second.records[0].runtimeId)
  assert.equal(first.records[0].accountKey, second.records[0].accountKey)
  assert.equal(first.records[0].sessionKey, second.records[0].sessionKey)
  for (let index = 0; index < 130; index++) {
    const trace = first.diagnostics.begin(connection, {...options, sessionId: SessionId(`private-session-${index}`)})
    trace.wireSession(`private-wire-${index}`)
    trace.finish('completed')
  }
  const trace = first.diagnostics.begin(connection, {...options, sessionId: SessionId('private-session-0')})
  trace.wireSession('private-wire-0')
  trace.finish('completed')
  assert.equal(first.records.at(-1)?.routing?.previousGapMs, undefined)
})

test('server observations keep only bounded identifiers, model slugs and fixed failure classifications', () => {
  const {records, diagnostics} = fixture()
  const trace = diagnostics.begin(connection, options)
  trace.event({type: 'response.created', response: {id: 'ignored-id', model: 'ignored'}})
  trace.event({type: 'response.completed', response: {id: 'private-response', model: 'gpt-fixture-1.0', status: 'completed',
    usage: {input_tokens: 100, output_tokens: 5}, secret: 'private-body'}})
  trace.event({type: 'error', error: {code: 'context_length_exceeded', message: 'private-error', token: 'private-token'}})
  trace.finish('failed')
  assert.match(records[0].server?.responseIdHash ?? '', /^[a-f0-9]{64}$/)
  assert.equal(records[0].server?.model, 'gpt-fixture-1.0')
  assert.equal(records[0].server?.status, 'completed')
  assert.equal(records[0].server?.failure, 'context-limit')
  assert.equal(JSON.stringify(records).includes('private-'), false)
  const bad = diagnostics.begin(connection, options)
  bad.event({type: 'response.failed', response: {id: 'x'.repeat(513), model: 'unsafe/model', status: 'made-up', error: {code: 'private-code'}}})
  bad.finish('failed')
  assert.deepEqual(records[1].server, {failure: 'other'})
})

test('request policy metadata survives a fingerprint budget skip without retaining key or image contents', () => {
  const {records, diagnostics} = fixture()
  const trace = diagnostics.begin(connection, options)
  const image = {image_url: `data:image/png;base64,${'x'.repeat(5 * 1024 * 1024)}`}
  Object.defineProperty(image, 'later', {enumerable: true, get() { throw new Error('walk exceeded budget') }})
  trace.body({input: [image], tools: [{name: 'private-tool'}], prompt_cache_key: 'private-cache-key',
    prompt_cache_retention: '24h', prompt_cache_options: {ttl: '12h'}, secret: 'private-body'})
  trace.finish('completed')
  assert.equal(records[0].prefixSkipped, 'budget-exceeded')
  assert.deepEqual(records[0].request, {inputItems: 1, toolCount: 1, cacheKeyPresent: true, cacheRetention: '24h', cacheTtl: '12h'})
  assert.equal(JSON.stringify(records).includes('private-'), false)
})

test('diagnostic event and routing failures cannot interrupt a request', () => {
  const {records, diagnostics} = fixture()
  const trace = diagnostics.begin(connection, options)
  const event = Object.defineProperty({type: 'response.completed'}, 'response', {get() { throw new Error('fixture observer failure') }})
  assert.doesNotThrow(() => trace.event(event))
  assert.doesNotThrow(() => trace.wireSession('private-wire'))
  trace.durability({reason: 'confirmed', candidates: 2, confirmed: 1})
  trace.finish('completed')
  assert.deepEqual(records[0].durability, {reason: 'confirmed', candidates: 2, confirmed: 1})
  assert.equal(records[0].outcome, 'completed')
})

test('a delayed earlier request cannot compare against or replace a later routing baseline', t => {
  t.mock.timers.enable({apis: ['Date'], now: 1_000})
  const {records, diagnostics} = fixture()
  const earlier = diagnostics.begin(connection, options)
  t.mock.timers.tick(1_000)
  const later = diagnostics.begin(connection, options)
  later.wireSession('private-wire-later')
  later.finish('completed')
  earlier.wireSession('private-wire-earlier')
  earlier.finish('completed')
  t.mock.timers.tick(1_000)
  const next = diagnostics.begin(connection, options)
  next.wireSession('private-wire-later')
  next.finish('completed')
  assert.equal(records[1].routing?.previousGapMs, undefined)
  assert.equal(records[2].routing?.previousGapMs, 1_000)
  assert.equal(records[2].routing?.wireSessionChanged, false)
})

test('observations record cache mode, comparison id, reasoning effort, cache diagnostics and terminal failure usage', () => {
  const {records, diagnostics} = fixture()
  const t1 = diagnostics.begin(connection, options)
  t1.body({
    input: [{role: 'user', content: 'hi'}],
    tools: [],
    prompt_cache_options: {mode: 'implicit', ttl: '30m', comparison_response_id: 'private-cmp-id'},
  })
  t1.event({
    type: 'response.completed',
    response: {
      id: 'private-resp-1',
      model: 'gpt-5.6-codex',
      status: 'completed',
      reasoning: {effort: 'high'},
      prompt_cache_diagnostics: {
        status: 'cache_miss',
        reason: 'tools',
        reusable_tokens: 400,
        lost_tokens: 120,
      },
      usage: {input_tokens: 520, output_tokens: 30, input_tokens_details: {cached_tokens: 400, cache_write_tokens: 100}},
    },
  })
  t1.finish('completed')

  const t2 = diagnostics.begin(connection, options)
  t2.event({
    type: 'response.incomplete',
    response: {
      id: 'private-resp-2',
      status: 'incomplete',
      incomplete_details: {reason: 'max_tokens_exceeded'},
      prompt_cache_diagnostics: {status: 'cache_miss', reason: 'unlisted_server_reason'},
      usage: {input_tokens: 100, output_tokens: 10, input_tokens_details: {cached_tokens: 80, cache_write_tokens: 25}},
    },
  })
  t2.finish('failed')

  const t3 = diagnostics.begin(connection, options)
  t3.event({
    type: 'response.completed',
    response: {
      id: 'private-resp-3',
      status: 'completed',
      prompt_cache_diagnostics: {
        type: 'cache_miss',
        comparison_reusable_tokens: 400,
        cache_missed_tokens: 120,
        reasons: ['tools_changed', 'reasoning_effort_changed', 'response_format_changed', 'ttl_expired', 'cache_evicted'],
      },
    },
  })
  t3.finish('completed')

  assert.deepEqual(records[0].request, {
    inputItems: 1, toolCount: 0, cacheKeyPresent: false, cacheTtl: '30m', cacheMode: 'implicit', comparisonIdPresent: true,
  })
  assert.equal(records[0].server?.reasoningEffort, 'high')
  assert.deepEqual(records[0].server?.cacheDiagnostics, {
    status: 'cache_miss', reason: 'tools', reusableTokens: 400, lostTokens: 120,
  })
  assert.equal(records[0].metering?.reportedCacheWriteTokens, 100)
  assert.equal(records[1].server?.cacheDiagnostics?.reason, 'unknown')
  assert.equal(records[1].metering?.usage, 'invalid')
  assert.equal(records[1].metering?.cache, 'invalid')
  assert.deepEqual(records[2].server?.cacheDiagnostics, {
    status: 'cache_miss',
    reason: 'tools',
    reasons: ['tools', 'reasoning_effort', 'format', 'ttl_expired', 'cache_evicted'],
    reusableTokens: 400,
    lostTokens: 120,
  })
  assert.equal(JSON.stringify(records).includes('private-'), false)
})
