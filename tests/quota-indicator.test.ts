import test from 'node:test'
import assert from 'node:assert/strict'
import { formatQuotaTime, quotaIndicator } from '../src/client/quota-indicator.js'
import type { SiwcStatus } from '../src/api/types.js'
import type { QuotaSnapshot } from '../src/quota/types.js'

const base: SiwcStatus = {authenticated: true, signingIn: false, planEnabled: true, availability: 'ready',
  accounts: [{id: 'a', email: 'fixture@example.test', authenticated: true, planEnabled: true}], activeAccountId: 'a',
  models: [], authorizedSessions: [], allowBackground: true, usage: {requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0}}
const snapshot: QuotaSnapshot = {updatedAt: 1_790_000_000_000, buckets: [{id: 'codex', windows: [
  {windowDurationMins: 300, usedPercent: 10}, {windowDurationMins: 10080, usedPercent: 68, resetsAt: 1_800_000_000},
], credits: {unlimited: false, balance: '0'}}]}
function linked(data: QuotaSnapshot = snapshot, stale = false): SiwcStatus {
  return {...base, quota: {codex: {state: 'ready', snapshot: data, linkedToCurrent: true},
    current: {state: stale ? 'unavailable' : 'ready', source: 'linked-codex', snapshot: data}}}
}

test('associated quota exposes the window values, credits and update time', () => {
  assert.deepEqual(quotaIndicator(linked()), {
    remaining: 32,
    windows: [{label: '5 小时', remaining: 90}, {label: '每周', remaining: 32, resetsAt: 1_800_000_000}],
    credits: '可用积分 0', updatedAt: snapshot.updatedAt,
  })
})
test('unlinked quota provides a concise association action', () => {
  const result = quotaIndicator({...base, quota: {codex: {state: 'ready', snapshot}}})
  assert.deepEqual(result, {windows: [], message: '请在插件设置中关联额度。'})
})
test('temporary failures preserve window values and mark the data as stale', () => {
  const result = quotaIndicator(linked(snapshot, true))
  assert.equal(result.remaining, 32)
  assert.equal(result.stale, true)
  assert.equal(result.updatedAt, snapshot.updatedAt)
})
test('selects an exact model bucket or an unambiguous shared bucket', () => {
  const buckets = [{id: 'special', model: 'fixture-model', windows: [{windowDurationMins: 300, usedPercent: 50}]},
    {id: 'codex', windows: [{windowDurationMins: 300, usedPercent: 10}]}]
  assert.equal(quotaIndicator(linked({...snapshot, buckets}), 'fixture-model').remaining, 50)
  assert.equal(quotaIndicator(linked({...snapshot, buckets}), 'another-model').remaining, 90)
  assert.equal(quotaIndicator(linked({...snapshot, buckets: [{id: 'primary', windows: [{windowDurationMins: 300, usedPercent: 20}]}]})).remaining, 80)
  assert.equal(quotaIndicator(linked({...snapshot, buckets: [buckets[0]]}), 'another-model').remaining, undefined)
})
test('missing windows stay unknown, zero remaining and unlimited credits remain meaningful', () => {
  assert.equal(quotaIndicator(linked({updatedAt: 1, buckets: []})).remaining, undefined)
  assert.equal(quotaIndicator(linked({...snapshot, buckets: [{id: 'codex', windows: [{windowDurationMins: 300, usedPercent: 100}]}]})).remaining, 0)
  assert.equal(quotaIndicator(linked({...snapshot, buckets: [{id: 'codex', windows: [], credits: {unlimited: true}}]})).credits, '积分不限量')
})
test('quota times use a local 24-hour clock', () => {
  const value = formatQuotaTime(new Date(2026, 9, 26, 13, 7).getTime())
  assert.match(value, /13:07/)
  assert.doesNotMatch(value, /AM|PM/i)
})
