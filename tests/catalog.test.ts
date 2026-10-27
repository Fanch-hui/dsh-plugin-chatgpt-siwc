import assert from 'node:assert/strict'
import test from 'node:test'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { decodeCatalog, fetchCatalog } from '../src/provider/catalog.js'

function model(capabilities: Record<string, unknown> = {}) {
  return { slug: 'fixture-model', display_name: 'Fixture model', visibility: 'list', ...capabilities }
}
function decode(capabilities: Record<string, unknown> = {}) {
  return decodeCatalog({ models: [model(capabilities)] })[0]
}

test('catalog preserves visible account model order and keeps missing capabilities unknown', () => {
  assert.deepEqual(decodeCatalog({ models: [model({slug: 'second'}), model({slug: 'hidden', visibility: 'hidden'}),
    model({slug: 'first'}), null, ['ignored']] }), [
    { provider: 'chatgpt-siwc', id: 'second', name: 'Fixture model' },
    { provider: 'chatgpt-siwc', id: 'first', name: 'Fixture model' },
  ])
  assert.deepEqual(decode(), { provider: 'chatgpt-siwc', id: 'fixture-model', name: 'Fixture model' })
})

test('account context budget and maximum remain separate and invalid capacities are omitted', () => {
  const actual = decode({ context_window: 128_000, max_context_window: 256_000 })
  assert.deepEqual(actual.context, {contextWindow: 128_000})
  assert.equal(actual.maxContextWindow, 256_000)
  const maximumOnly = decode({max_context_window: 256_000})
  assert.equal(maximumOnly.context, undefined)
  assert.equal(maximumOnly.maxContextWindow, 256_000)
  for (const value of [-1, 0, NaN, Infinity, 1.5, '128000', Number.MAX_SAFE_INTEGER + 1]) {
    const result = decode({context_window: value, max_context_window: value})
    assert.equal(result.context, undefined)
    assert.equal(result.maxContextWindow, undefined)
  }
  assert.equal(decode({context_window: 200, max_context_window: 100}).maxContextWindow, undefined)
})

test('reasoning efforts preserve directory order, labels and the declared matching default', () => {
  const actual = decode({supported_reasoning_levels: [
    'low', {effort: 'high', display_name: 'High detail', description: 'More reasoning'}, 'low',
  ], default_reasoning_level: 'high'})
  assert.deepEqual(actual.reasoning, {
    efforts: [ {id: ReasoningEffortId('low'), name: 'low'},
      {id: ReasoningEffortId('high'), name: 'High detail', description: 'More reasoning'} ],
    defaultEffort: ReasoningEffortId('high'),
  })
  assert.equal(actual.defaultReasoningEffort, 'high')
  assert.deepEqual(decode({supported_reasoning_efforts: []}).reasoning, {efforts: []})
  assert.equal(decode({default_reasoning_effort: 'medium'}).defaultReasoningEffort, 'medium')
  assert.equal(decode({default_reasoning_effort: 'medium'}).reasoning, undefined)
})

test('invalid reasoning declarations stay unknown and defaults cannot expand an explicit effort list', () => {
  for (const value of ['high', null, [2], [{name: 'high'}], ['high', '']]) {
    assert.equal(decode({supported_reasoning_levels: value}).reasoning, undefined)
  }
  const result = decode({supported_reasoning_levels: ['low'], default_reasoning_level: 'high'})
  assert.equal(result.defaultReasoningEffort, undefined)
  assert.equal(result.reasoning?.defaultEffort, undefined)
  assert.deepEqual(result.reasoning?.efforts.map(item => item.id), ['low'])
  assert.deepEqual(decode({reasoning: {supported_efforts: ['minimal', 'high']}}).reasoning?.efforts.map(item => item.id),
    ['minimal', 'high'])
})

test('explicit modalities control image support while partial image declarations remain partial', () => {
  const multimodal = decode({input_modalities: ['text', 'image', 'text'], supports_images: false})
  assert.deepEqual(multimodal.inputModalities, ['text', 'image'])
  assert.equal(multimodal.imageInput, true)
  assert.deepEqual(decode({input_modalities: ['text']}).inputModalities, ['text'])
  assert.equal(decode({input_modalities: ['text']}).imageInput, false)
  for (const supported of [true, false]) {
    assert.equal(decode({supports_images: supported}).imageInput, supported)
    assert.equal(decode({supports_images: supported}).inputModalities, undefined)
  }
  assert.equal(decode({input_modalities: ['text', 42], supports_images: 'true'}).inputModalities, undefined)
  assert.equal(decode({input_modalities: ['text', 42], supports_images: 'true'}).imageInput, undefined)
})

test('catalog rejects malformed top-level data and visible identities', () => {
  for (const raw of [null, [], {}, {models: {}}, {models: [model({slug: ''})]}, {models: [model({display_name: ''})]}]) {
    assert.throws(() => decodeCatalog(raw), {code: 'SIWC_INVALID_CATALOG'})
  }
})

test('fetch uses the account catalog without extra discovery requests and forwards cancellation', async () => {
  const controller = new AbortController()
  let calls = 0
  const fetcher: typeof fetch = async (input, init) => {
    calls++
    assert.equal(input, 'https://api.openai.com/v1/models')
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-access')
    assert.equal(init?.signal, controller.signal)
    return Response.json({models: [model({context_window: 4096})]})
  }
  const result = await fetchCatalog('fixture-access', controller.signal, fetcher)
  assert.equal(calls, 1)
  assert.deepEqual(result[0].context, {contextWindow: 4096})
})
