import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import type { ImageBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { BaselineStore, baselineRetentionMs } from '../src/diagnostics/baselines.js'
import { unifiedMetrics } from '../src/diagnostics/export.js'
import { RequestDiagnostics } from '../src/diagnostics/requests.js'
import { ChatGPTSiwcAdapter } from '../src/provider/adapter.js'
import type { RequestDiagnostic } from '../src/diagnostics/types.js'

const connection = {id: 'fixture-connection', accountId: 'fixture-account', accessToken: 'private-fixture-access'}
const options = {provider: 'chatgpt-siwc', model: 'fixture-model', sessionId: SessionId('fixture-session'), messages: []}
function fixture() {
  const records: RequestDiagnostic[] = []
  const diagnostics = new RequestDiagnostics({record: value => { records.push(value) }}, value => value.sessionId ? 'conversation' : 'independent')
  return {records, diagnostics}
}

test('request fingerprints detect append-only history and the first changed item without keeping content', () => {
  const {records, diagnostics} = fixture()
  const body = {model: 'fixture-model', instructions: 'private-fixture-policy', tools: [{name: 'private-tool'}],
    input: [{role: 'user', content: 'private-fixture-message'}]}
  const run = (value: typeof body) => {
    const trace = diagnostics.begin(connection, options)
    trace.body(value)
    trace.decision({mode: 'ws-full', reason: 'cold-connection'})
    trace.usage({inputTokens: 40, cacheReadTokens: 60, outputTokens: 5})
    trace.finish('completed')
  }
  run(body)
  run({...body, input: [...body.input, {role: 'assistant', content: 'fixture-reply'}]})
  run({...body, instructions: 'changed-policy', input: [{role: 'user', content: 'edited'}]})
  assert.equal(records[0].prefix?.change, 'first')
  assert.equal(records[1].prefix?.change, 'append')
  assert.equal(records[1].prefix?.sharedItems, 1)
  assert.equal(records[2].prefix?.change, 'changed')
  assert.equal(records[2].prefix?.firstDifference, 0)
  assert.equal(records[2].prefix?.instructionsChanged, true)
  assert.equal(records[1].inputTokens, 100)
  assert.equal(records[1].cachedTokens, 60)
  const serialized = JSON.stringify(records)
  for (const forbidden of ['private-fixture', 'private-tool', 'fixture-session', 'fixture-account', 'fixture-connection']) {
    assert.equal(serialized.includes(forbidden), false)
  }
})

test('independent policies and different sessions do not compare unrelated histories', () => {
  const {records, diagnostics} = fixture()
  const run = (instructions: string, sessionId?: typeof options.sessionId) => {
    const trace = diagnostics.begin(connection, {...options, sessionId})
    trace.body({instructions, tools: [], input: [{role: 'user', content: 'fixture'}]})
    trace.finish('completed')
  }
  run('review-policy')
  run('title-policy')
  run('review-policy')
  run('review-policy', options.sessionId)
  run('review-policy', SessionId('different-session'))
  assert.deepEqual(records.map(value => value.prefix?.change), ['first', 'first', 'unchanged', 'first', 'first'])
  assert.equal(records[0].sessionKey, undefined)
})

test('adapter records HTTP usage and failures while diagnostics stay outside provider requests', async () => {
  const {records, diagnostics} = fixture()
  let fail = false
  const adapter = new ChatGPTSiwcAdapter({diagnostics, connection: async () => connection, authorize: async () => {},
    fetch: async (url, init) => {
      if (String(url).endsWith('/models')) return Response.json({models: [{slug: 'fixture-model', display_name: 'Fixture', visibility: 'list'}]})
      const body = JSON.parse(String(init?.body))
      assert.equal('diagnostics' in body, false)
      if (fail) return Response.json({error: {code: 'fixture_failure'}}, {status: 500})
      return new Response(`data: ${JSON.stringify({type: 'response.completed', response: {id: 'fixture-response', output: [
        {type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'Fixture reply'}]},
      ], usage: {input_tokens: 100, input_tokens_details: {cached_tokens: 75}, output_tokens: 5}}})}\n\n`)
    }})
  try {
    for await (const _ of adapter.stream({...options, sessionId: undefined})) {}
    fail = true
    await assert.rejects(async () => { for await (const _ of adapter.stream({...options, sessionId: undefined})) {} })
    assert.equal(records.length, 2)
    assert.equal(records[0].category, 'independent')
    assert.deepEqual(records[0].transport, [{mode: 'http', reason: 'independent-call'}])
    assert.equal(records[0].inputTokens, 100)
    assert.equal(records[0].cachedTokens, 75)
    assert.equal(records[1].outcome, 'failed')
    assert.equal(records[1].inputTokens, undefined)
  } finally { adapter.dispose() }
})

test('diagnostics failures do not escape into inference completion', () => {
  const diagnostics = new RequestDiagnostics({record() { throw new Error('fixture write failure') }}, () => 'conversation')
  const trace = diagnostics.begin(connection, options)
  assert.doesNotThrow(() => trace.finish('completed'))
})

test('HTTP image preparation failure stays unsent and leaves route, prefix, and metering baselines untouched', async () => {
  const {records, diagnostics} = fixture()
  let imagePreparations = 0, responsePosts = 0
  const image: ImageBlock = {type: 'image', attachment: {
    attachmentId: 'sha256:fixture-diagnostic-image' as ImageBlock['attachment']['attachmentId'],
    mediaType: 'image/png', bytes: 5, width: 4, height: 3, name: 'fixture.png',
  }}
  const adapter = new ChatGPTSiwcAdapter({
    diagnostics, connection: async () => connection, authorize: async () => {}, websocket: false,
    image: async () => { imagePreparations++; throw new Error('fixture image preparation failed') },
    fetch: async url => {
      if (String(url).endsWith('/models')) return Response.json({models: [{
        slug: 'fixture-model', display_name: 'Fixture', visibility: 'list', input_modalities: ['text', 'image'],
      }]})
      responsePosts++
      return new Response(`data: ${JSON.stringify({type: 'response.completed', response: {
        id: 'fixture-after-image-failure', output: [
          {type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'Fixture reply'}]},
        ], usage: {input_tokens: 100, input_tokens_details: {cached_tokens: 75}, output_tokens: 5},
      }})}\n\n`)
    },
  })
  try {
    await assert.rejects(async () => {
      for await (const _ of adapter.stream({...options, messages: [{role: 'user', content: [image]}]})) {}
    }, /fixture image preparation failed/)
    assert.equal(imagePreparations, 1)
    assert.equal(responsePosts, 0)
    assert.equal(records.length, 1)
    assert.equal(records[0].outcome, 'failed')
    assert.equal(records[0].sent, false)
    assert.deepEqual(records[0].transport, [{mode: 'http', reason: 'websocket-disabled'}])
    assert.equal(records[0].timings?.requestSentAt, undefined)
    assert.equal(records[0].request, undefined)
    assert.equal(records[0].prefix, undefined)
    assert.equal(unifiedMetrics(records).missingCacheSamples, 0)
    assert.equal(unifiedMetrics(records).meteringCoverageRate, undefined)

    for await (const _ of adapter.stream({...options, messages: [{role: 'user', content: [{type: 'text', text: 'Continue'}]}]})) {}
    assert.equal(responsePosts, 1)
    assert.equal(records[1].sent, true)
    assert.equal(records[1].prefix?.change, 'first')
    assert.equal(records[1].baselineRequestId, undefined)
    assert.equal(records[1].routing?.previousGapMs, undefined)
    const metrics = unifiedMetrics(records)
    assert.equal(metrics.missingCacheSamples, 0)
    assert.equal(metrics.meteringCoverageRate, 1)
    assert.equal(metrics.totalInputTokens, 100)
    assert.equal(metrics.cachedTokens, 75)
  } finally { adapter.dispose() }
})

test('oversized image fingerprints skip before later content and preserve usage and transport', () => {
  const {records, diagnostics} = fixture()
  const small = {instructions: 'fixture-policy', tools: [], input: [{content: 'fixture-message'}]}
  const run = (body: Record<string, unknown>) => {
    const trace = diagnostics.begin(connection, options)
    trace.body(body)
    trace.decision({mode: 'ws-incremental', reason: 'continued'})
    trace.usage({inputTokens: 40, cacheReadTokens: 60, outputTokens: 5})
    trace.finish('completed')
  }
  run(small)
  const image = {image_url: `data:image/png;base64,${'x'.repeat(5 * 1024 * 1024)}`}
  Object.defineProperty(image, 'later', {enumerable: true, get() { throw new Error('diagnostic traversal continued past its budget') }})
  run({...small, input: [image]})
  run(small)
  assert.equal(records[1].prefix, undefined)
  assert.equal(records[1].prefixSkipped, 'budget-exceeded')
  assert.equal(records[1].inputTokens, 100)
  assert.equal(records[1].cachedTokens, 60)
  assert.equal(records[1].outcome, 'completed')
  assert.deepEqual(records[1].transport, [{mode: 'ws-incremental', reason: 'continued'}])
  assert.equal(records[2].prefix?.change, 'first')
})

test('bounded observation keeps ordinary large text and clears independent policy baselines after a skip', () => {
  const {records, diagnostics} = fixture()
  const run = (body: Record<string, unknown>) => {
    const trace = diagnostics.begin(connection, {...options, sessionId: undefined})
    trace.body(body)
    trace.finish('completed')
  }
  const body = {instructions: 'fixture-policy', tools: [], input: [{content: 'x'.repeat(1024 * 1024)}]}
  run(body)
  run({...body, input: [{content: '\u0000'.repeat(1024 * 1024)}]})
  run(body)
  assert.ok(records[0].prefix)
  assert.equal(records[1].prefixSkipped, 'budget-exceeded')
  assert.equal(records[2].prefix?.change, 'first')
})

test('diagnostics preserve unknown cache accounting instead of recording a zero hit', () => {
  const {records, diagnostics} = fixture()
  for (const cacheReadTokens of [undefined, 0]) {
    const trace = diagnostics.begin(connection, options)
    trace.usage({inputTokens: 100, outputTokens: 5, ...(cacheReadTokens === undefined ? {} : {cacheReadTokens})})
    trace.finish('completed')
  }
  assert.equal(records[0].inputTokens, 100)
  assert.equal(Object.hasOwn(records[0], 'cachedTokens'), false)
  assert.equal(records[1].cachedTokens, 0)
})

test('disconnect diagnostics record cause, close code and last event sequence without retaining event payload', () => {
  const {records, diagnostics} = fixture()
  const trace = diagnostics.begin(connection, options)
  trace.disconnect({cause: 'remote-closed', closeCode: 1006, lastEventType: 'response.output_text.delta', lastEventSequence: 2})
  trace.finish('failed')
  assert.deepEqual(records[0].disconnect, {
    cause: 'remote-closed', closeCode: 1006, lastEventType: 'response.output_text.delta', lastEventSequence: 2,
  })
})

test('semantic settings exclude transport/comparison fields while tracking policy, developer hashes, and expected output', () => {
  const {records, diagnostics} = fixture()
  const t1 = diagnostics.begin(connection, options)
  t1.body({
    model: 'fixture-model', instructions: '', tools: [], stream: true, store: false,
    prompt_cache_retention: 'in_memory',
    prompt_cache_options: {mode: 'implicit', ttl: '30m', comparison_response_id: 'resp-1'},
    input: [{role: 'developer', content: 'dev-1'}, {role: 'user', content: 'u-1'}],
  })
  t1.event({type: 'response.completed', response: {id: 'resp-2', output: [{type: 'message', role: 'assistant', content: 'a-1'}]}})
  t1.finish('completed')

  const t2 = diagnostics.begin(connection, options)
  t2.body({
    model: 'fixture-model', instructions: '', tools: [], previous_response_id: 'resp-2', background: false,
    prompt_cache_retention: 'in_memory',
    prompt_cache_options: {mode: 'implicit', ttl: '30m', comparison_response_id: 'resp-2'},
    input: [
      {role: 'developer', content: 'dev-1'}, {role: 'user', content: 'u-1'},
      {type: 'message', role: 'assistant', content: 'a-1'},
      {role: 'developer', content: 'dev-2'}, {role: 'user', content: 'u-2'},
    ],
  })
  t2.event({type: 'response.completed', response: {id: 'resp-3', output: [{type: 'message', role: 'assistant', content: 'a-2'}]}})
  t2.finish('completed')

  const t3 = diagnostics.begin(connection, options)
  t3.body({
    model: 'fixture-model', instructions: 'top-level-sys', tools: [],
    input: [{role: 'developer', content: 'dev-1'}, {role: 'user', content: 'u-1'}, {type: 'message', role: 'assistant', content: 'mutated-a-1'}],
  })
  t3.finish('completed')

  assert.equal(records[0].prefix?.systemPromptSource, 'leading-message')
  assert.equal(records[0].prefix?.developerHashes?.length, 1)
  assert.equal(records[1].prefix?.settingsChanged, false)
  assert.equal(records[1].prefix?.policyHash, records[0].prefix?.policyHash)
  assert.equal(records[1].prefix?.systemPromptSource, 'in-history')
  assert.equal(records[1].prefix?.developerHashes?.length, 2)
  assert.equal(records[1].prefix?.expectedOutputMatched, true)
  assert.equal(records[1].baselineRequestId, records[0].id)
  assert.equal(records[2].prefix?.systemPromptSource, 'system-field')
  assert.equal(records[2].prefix?.expectedOutputMatched, false)
})

test('cross-restart baselines persist under profileDir, survive delayed rotateSecret, and skip unsent requests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-baselines-test-'))
  try {
    const secret = Buffer.alloc(32, 7)
    const firstRecords: RequestDiagnostic[] = []
    const first = new RequestDiagnostics(
      {record: v => { firstRecords.push(v) }}, v => v.sessionId ? 'conversation' : 'independent',
      {profileDir: root, secret: {keyId: 'key-v1', secret}},
    )
    const t1 = first.begin(connection, options)
    t1.wireSession('wire-1')
    t1.body({instructions: 'sys', tools: [], input: [{role: 'user', content: 'hello'}]})
    t1.finish('completed')
    await first.flushBaselines()

    // Constructed WITHOUT initial secret, then rotateSecret(persistedSecret) loads pre-existing baselines from profileDir
    const secondRecords: RequestDiagnostic[] = []
    const second = new RequestDiagnostics(
      {record: v => { secondRecords.push(v) }}, v => v.sessionId ? 'conversation' : 'independent',
      {profileDir: root},
    )
    second.rotateSecret({keyId: 'key-v1', secret})
    // Cancelled/failed request before request-sent must NOT commit route or prefix baselines
    const cancelled = second.begin(connection, options)
    cancelled.wireSession('wire-cancelled')
    cancelled.body({instructions: 'sys', tools: [], input: [{role: 'user', content: 'cancelled'}]})
    cancelled.finish('cancelled')

    const t2 = second.begin(connection, options)
    t2.wireSession('wire-1')
    t2.body({instructions: 'sys', tools: [], input: [{role: 'user', content: 'hello'}, {role: 'assistant', content: 'world'}]})
    // In-flight rotateSecret keeps t2 on its captured requestKeyId/requestSecret snapshot
    second.rotateSecret({keyId: 'key-v2', secret: Buffer.alloc(32, 9)})
    t2.finish('completed')
    await second.flushBaselines()

    assert.equal(secondRecords[1].prefix?.change, 'append')
    assert.equal(secondRecords[1].baselineRequestId, firstRecords[0].id)
    assert.equal(secondRecords[1].routing?.wireSessionChanged, false)
    assert.equal(secondRecords[1].keyId, 'key-v1')

    let expiredNotified = false
    const thirdRecords: RequestDiagnostic[] = []
    const third = new RequestDiagnostics(
      {record: v => { thirdRecords.push(v) }}, v => v.sessionId ? 'conversation' : 'independent',
      {profileDir: root, secret: {keyId: 'key-v1', secret, expiresAt: Date.now() - 1}, onSecretExpired: () => { expiredNotified = true }},
    )
    const t3 = third.begin(connection, options)
    t3.body({instructions: 'sys', tools: [], input: [{role: 'user', content: 'hello'}]})
    t3.finish('completed')
    await third.flushBaselines()
    assert.equal(expiredNotified, true); assert.equal(thirdRecords[0].prefix?.change, 'first')
    const bs = new BaselineStore(), now = 10_000
    bs.setPrefix({lane: 'a'.repeat(64), scope: 'b'.repeat(64), keyId: 'k1', startedAt: now, updatedAt: now,
      baselineRequestId: 'req-1', instructions: 'c'.repeat(64), tools: 'd'.repeat(64), settings: 'e'.repeat(64), items: ['f'.repeat(64)]}, now)
    assert.equal(bs.getPrefix('a'.repeat(64), 'k1', now + baselineRetentionMs + 1), undefined)
  } finally { await rm(root, {recursive: true, force: true}) }
})

test('late completion and delayed body submission under an old key cannot replace the new key baseline', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-baselines-key-race-'))
  t.mock.timers.enable({apis: ['Date'], now: 10_000})
  const records: RequestDiagnostic[] = []
  const secret = {keyId: 'fixture-key-2', secret: Buffer.alloc(32, 2)}
  const diagnostics = new RequestDiagnostics({record: value => { records.push(value) }}, () => 'conversation',
    {profileDir: root, secret: {keyId: 'fixture-key-1', secret: Buffer.alloc(32, 1)}})
  try {
    const oldSent = diagnostics.begin(connection, options)
    oldSent.wireSession('wire-old-sent')
    oldSent.body({tools: [], input: [{role: 'user', content: 'old sent input'}]})
    oldSent.timing('request-sent')
    t.mock.timers.tick(1)
    const oldDelayed = diagnostics.begin(connection, options)
    oldDelayed.wireSession('wire-old-delayed')

    diagnostics.rotateSecret(secret)
    t.mock.timers.tick(1)
    const currentInput = [{role: 'user', content: 'current input'}]
    const currentOutput = [{type: 'message', role: 'assistant', content: 'current output'}]
    const current = diagnostics.begin(connection, options)
    current.wireSession('wire-current')
    current.body({tools: [], input: currentInput})
    current.event({type: 'response.completed', response: {id: 'fixture-current-response', output: currentOutput}})
    current.finish('completed')
    const currentRecord = records[0]
    assert.equal(currentRecord.keyId, secret.keyId)

    // Both old traces retain K1, but K2 has already committed its input and expected output.
    oldSent.event({type: 'response.completed', response: {
      id: 'fixture-old-sent-response', output: [{type: 'message', role: 'assistant', content: 'old sent output'}],
    }})
    oldSent.finish('completed')
    oldDelayed.body({tools: [], input: [{role: 'user', content: 'old delayed input'}]})
    oldDelayed.timing('request-sent')
    oldDelayed.event({type: 'response.completed', response: {
      id: 'fixture-old-delayed-response', output: [{type: 'message', role: 'assistant', content: 'old delayed output'}],
    }})
    oldDelayed.finish('completed')
    assert.equal(records[1].keyId, 'fixture-key-1')
    assert.equal(records[2].keyId, 'fixture-key-1')
    await diagnostics.flushBaselines()

    const nextInput = [...currentInput, ...currentOutput, {role: 'user', content: 'next question'}]
    const check = (observer: RequestDiagnostics) => {
      t.mock.timers.tick(1)
      const next = observer.begin(connection, options)
      next.wireSession('wire-current')
      next.body({tools: [], input: nextInput})
      next.finish('cancelled')
      const record = records.at(-1)!
      assert.equal(record.baselineRequestId, currentRecord.id)
      assert.equal(record.prefix?.change, 'append')
      assert.equal(record.prefix?.expectedOutputMatched, true)
      assert.equal(record.routing?.wireSessionChanged, false)
      assert.equal(record.sent, false)
    }
    check(diagnostics)
    const restarted = new RequestDiagnostics({record: value => { records.push(value) }}, () => 'conversation',
      {profileDir: root, secret})
    check(restarted)
    await restarted.flushBaselines()
  } finally {
    await diagnostics.flushBaselines()
    await rm(root, {recursive: true, force: true})
  }
})

test('preparing an unsent retry preserves the last sent prefix, including a deferred budget skip', () => {
  const sentBody = {tools: [], input: [{role: 'user', content: 'sent input'}]}
  for (const nextBody of [
    {tools: [], input: [{role: 'user', content: 'prepared but unsent input'}]},
    {tools: [], input: [{role: 'user', content: 'x'.repeat(5 * 1024 * 1024)}]},
  ]) {
    const {records, diagnostics} = fixture()
    const trace = diagnostics.begin(connection, options)
    trace.wireSession('wire-sent')
    trace.body(sentBody)
    trace.decision({mode: 'ws-full', reason: 'cold-connection'})
    trace.timing('request-sent')
    trace.body(nextBody)
    trace.decision({mode: 'http-fallback', reason: 'fixture-retry'})
    trace.finish('cancelled')
    assert.equal(records[0].sent, true)

    const next = diagnostics.begin(connection, options)
    next.wireSession('wire-sent')
    next.body(sentBody)
    next.finish('cancelled')
    assert.equal(records[1].baselineRequestId, records[0].id)
    assert.equal(records[1].prefix?.change, 'unchanged')
    assert.equal(records[1].prefix?.sharedItems, 1)
    assert.equal(records[1].routing?.wireSessionChanged, false)
    assert.equal(records[1].sent, false)
  }
})

test('completed reasoning summaries record first content without treating it as answer text', t => {
  t.mock.timers.enable({apis: ['Date'], now: 1000})
  for (const type of ['response.reasoning_summary_text.done', 'response.reasoning_summary_part.done']) {
    const {records, diagnostics} = fixture()
    const trace = diagnostics.begin(connection, options)
    trace.timing('request-sent', 1000)
    const event = (text: string) => type === 'response.reasoning_summary_text.done'
      ? {type, text} : {type, part: {type: 'summary_text', text}}
    t.mock.timers.setTime(1010)
    trace.event(event(''))
    t.mock.timers.setTime(1020)
    trace.event(event('A completed reasoning summary.'))
    trace.finish('completed')
    assert.equal(records[0].timings?.firstContentAt, 1020, type)
    assert.equal(records[0].timings?.firstContentMs, 20, type)
    assert.equal(records[0].timings?.firstTextAt, undefined, type)
  }
})

test('timings ignore empty items/deltas, isolate per-attempt arrival marks, and deduplicate terminal usage', t => {
  t.mock.timers.enable({apis: ['Date'], now: 1000})
  const {records, diagnostics} = fixture()
  const trace = diagnostics.begin(connection, options)
  trace.replay({totalBlocks: 4, nativeBlocks: 3, degradedBlocks: 1, reasons: ['edited']})
  trace.timing('handshake-start', 1000)
  trace.timing('handshake-end', 1020)
  trace.timing('request-sent', 1050)
  t.mock.timers.tick(20)
  trace.event({type: 'response.output_item.added', item: {type: 'message', content: []}})
  trace.event({type: 'response.output_text.delta', delta: ''})
  assert.equal(records[0]?.timings?.firstContentAt, undefined)
  // Retry attempt resets handshakeCompletedAt and prior attempt arrival marks
  trace.timing('handshake-start', 2000)
  trace.timing('request-sent', 2050)
  t.mock.timers.setTime(2090)
  trace.event({type: 'response.reasoning_text.delta', delta: 'thinking'})
  t.mock.timers.setTime(2120)
  trace.event({type: 'response.output_text.delta', delta: 'hello'})
  trace.event({type: 'response.completed', response: {id: 'resp-dup'}})
  trace.usage({inputTokens: 10, cacheReadTokens: 70, cacheWriteTokens: 20, outputTokens: 5})
  trace.usage({inputTokens: 10, cacheReadTokens: 70, cacheWriteTokens: 20, outputTokens: 5})
  trace.finish('completed')

  assert.equal(records[0].timings?.handshakeCompletedAt, undefined)
  assert.equal(records[0].timings?.firstServerEventAt, 2090)
  assert.equal(records[0].timings?.firstContentMs, 40)
  assert.equal(records[0].timings?.firstTextMs, 70)
  assert.deepEqual(records[0].replay, {totalBlocks: 4, nativeBlocks: 3, degradedBlocks: 1, reasons: ['edited']})
  assert.equal(records[0].inputTokens, 100)
  assert.equal(records[0].cachedTokens, 70)
  assert.equal(records[0].cacheWriteTokens, 20)
  assert.equal(records[0].outputTokens, 5)
})
