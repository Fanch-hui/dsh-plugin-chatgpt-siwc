import assert from 'node:assert/strict'
import test from 'node:test'
import { parseQuota } from '../src/quota/parse.js'

const window = { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 }

test('projects multiple official quota buckets and prioritizes their map', () => {
  const snapshot = parseQuota({
    rateLimits: { limitId: 'legacy', primary: { ...window, usedPercent: 99 } },
    rateLimitsByLimitId: {
      codex: { limitId: 'codex', planType: 'plus', primary: window, secondary: null },
      codex_other: { limitId: 'codex_other', limitName: 'Additional model', primary: null,
        secondary: { ...window, usedPercent: 60, windowDurationMins: 10_080 },
        credits: { hasCredits: true, unlimited: false, balance: '12.50' } },
    },
  })
  assert.deepEqual(snapshot.buckets, [
    { id: 'codex', planType: 'plus', windows: [window] },
    { id: 'codex_other', name: 'Additional model', windows: [{ ...window, usedPercent: 60, windowDurationMins: 10_080 }],
      credits: { unlimited: false, balance: '12.50' } },
  ])
  assert.ok(snapshot.updatedAt <= Date.now())
})

test('legacy quotas preserve unknown windows instead of fabricating zero usage', () => {
  assert.deepEqual(parseQuota({ rateLimits: { primary: null, secondary: null, credits: { unlimited: true, balance: null } } }).buckets,
    [{ id: 'codex', windows: [], credits: { unlimited: true } }])
  assert.deepEqual(parseQuota({ rateLimits: null, rateLimitsByLimitId: null }).buckets, [])
  assert.deepEqual(parseQuota({ rateLimits: { primary: { usedPercent: 0, windowDurationMins: 60 } } }).buckets,
    [{ id: 'codex', windows: [{ usedPercent: 0, windowDurationMins: 60 }] }])
})

test('projects the backend model association for a quota alias', () => {
  const snapshot = parseQuota({rateLimitsByLimitId: {
    model_pool: {limitId: 'model_pool', normalModelSlug: 'fixture-model', primary: window},
    codex: {limitId: 'codex', normalModelSlug: null, primary: window},
  }})
  assert.deepEqual(snapshot.buckets, [
    {id: 'model_pool', model: 'fixture-model', windows: [window]},
    {id: 'codex', windows: [window]},
  ])
})

test('quota projection keeps numeric usage and excludes identity and diagnostic fields', () => {
  const syntheticPrivate = { access_token: 'fixture-private', accountId: 'fixture-account', user_id: 'fixture-user', error: 'fixture-private' }
  const output = parseQuota({...syntheticPrivate, rateLimits: {...syntheticPrivate, primary: {...window, ...syntheticPrivate}}})
  const encoded = JSON.stringify(output)
  assert.ok(!encoded.includes('fixture-private'))
  assert.ok(!encoded.includes('fixture-account'))
  assert.ok(!encoded.includes('fixture-user'))
  assert.deepEqual(JSON.parse(encoded), output)
  assert.deepEqual(output.buckets, [{id: 'codex', windows: [window]}])
})

test('invalid payloads and known malformed quota fields return one safe error', () => {
  const inputs: unknown[] = [
    {}, null, { rateLimits: { access_token: 'fixture-private' } },
    { rateLimitsByLimitId: { codex: { limitId: 'different', primary: window } } },
    { rateLimits: { primary: { ...window, usedPercent: -1 } } },
    { rateLimits: { primary: { ...window, usedPercent: 101 } } },
    { rateLimits: { primary: { ...window, usedPercent: NaN } } },
    { rateLimits: { primary: { ...window, windowDurationMins: Infinity } } },
    { rateLimits: { primary: { ...window, resetsAt: 0 } } },
    { rateLimits: { credits: { unlimited: false, balance: 'fixture-private' } } },
    { rateLimits: { credits: { unlimited: false, balance: 5 } } },
  ]
  for (const input of inputs) assert.throws(() => parseQuota(input), { message: '额度服务返回的数据格式无效。' })
})
