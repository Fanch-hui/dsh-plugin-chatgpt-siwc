import test from 'node:test'
import assert from 'node:assert/strict'
import { withinFingerprintBudget } from '../src/diagnostics/budget.js'
import { diagnosticRecordSchema } from '../src/diagnostics/schema.js'

test('fingerprint budget bounds wide and deeply nested inputs before serialization', () => {
  assert.equal(withinFingerprintBudget(new Array(20_000).fill(null)), false)
  let nested: unknown = 'fixture'
  for (let depth = 0; depth < 70; depth++) nested = [nested]
  assert.equal(withinFingerprintBudget(nested), false)
  const cyclic: {self?: unknown} = {}
  cyclic.self = cyclic
  assert.equal(withinFingerprintBudget(cyclic), false)
})

test('fingerprint budget accounts for UTF-8, escaped characters and object keys', () => {
  assert.equal(withinFingerprintBudget({text: 'a'.repeat(1024 * 1024)}), true)
  assert.equal(withinFingerprintBudget({text: '界'.repeat(2 * 1024 * 1024)}), false)
  assert.equal(withinFingerprintBudget({text: '\ud800'.repeat(1024 * 1024)}), false)
  assert.equal(withinFingerprintBudget({['x'.repeat(5 * 1024 * 1024)]: true}), false)
})

test('diagnostics allowlist retains only the fingerprint budget skip marker', () => {
  const value = diagnosticRecordSchema.parse({id: 'fixture', startedAt: 1, durationMs: 1,
    accountKey: 'a'.repeat(64), model: 'fixture', category: 'conversation', outcome: 'completed',
    transport: [], prefixSkipped: 'budget-exceeded', body: 'fixture-private-content'})
  assert.equal(value.prefixSkipped, 'budget-exceeded')
  assert.equal('body' in value, false)
})
