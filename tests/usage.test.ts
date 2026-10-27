import test from 'node:test'
import assert from 'node:assert/strict'
import { parseUsage } from '../src/provider/stream.js'

test('usage preserves unavailable cache accounting separately from an explicit zero', () => {
  const missing = parseUsage({input_tokens: 100, output_tokens: 5})
  const zero = parseUsage({input_tokens: 100, output_tokens: 5, input_tokens_details: {cached_tokens: 0}})
  assert.deepEqual(missing, {inputTokens: 100, outputTokens: 5})
  assert.deepEqual(zero, {inputTokens: 100, outputTokens: 5, cacheReadTokens: 0})
})

test('usage rejects non-finite input, output and cache counts before stream serialization', () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.equal(parseUsage({input_tokens: value, output_tokens: 5}), undefined)
    assert.equal(parseUsage({input_tokens: 100, output_tokens: value}), undefined)
    assert.equal(parseUsage({input_tokens: 100, output_tokens: 5, input_tokens_details: {cached_tokens: value}}), undefined)
  }
  assert.deepEqual(parseUsage({input_tokens: 100, output_tokens: 5, output_tokens_details: {reasoning_tokens: Infinity}}),
    {inputTokens: 100, outputTokens: 5})
})

test('usage accounts disjoint cacheReadTokens and cacheWriteTokens and rejects invalid cache_write_tokens', () => {
  assert.deepEqual(
    parseUsage({
      input_tokens: 100,
      output_tokens: 15,
      total_tokens: 115,
      input_tokens_details: { cached_tokens: 40, cache_write_tokens: 25 },
    }),
    { inputTokens: 35, outputTokens: 15, totalTokens: 115, cacheReadTokens: 40, cacheWriteTokens: 25 },
  )
  assert.deepEqual(
    parseUsage({
      input_tokens: 100,
      output_tokens: 5,
      input_tokens_details: { cache_write_tokens: 0 },
    }),
    { inputTokens: 100, outputTokens: 5, cacheWriteTokens: 0 },
  )
  for (const invalid of [-1, 1.5, NaN, Infinity, 61]) {
    assert.equal(
      parseUsage({
        input_tokens: 100,
        output_tokens: 5,
        input_tokens_details: { cached_tokens: 40, cache_write_tokens: invalid },
      }),
      undefined,
    )
  }
})
