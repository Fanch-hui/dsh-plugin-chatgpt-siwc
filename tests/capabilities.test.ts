import assert from 'node:assert/strict'
import test from 'node:test'
import { CAPABILITY_PROJECTION_VERSION, CapabilityRegistry, isUnsupportedParameterError, requestCapabilityProbes } from '../src/provider/capabilities.js'
import { ProviderError } from '../src/provider/errors.js'

const body = {
  prompt_cache_options: {mode: 'implicit', ttl: '30m'},
  prompt_cache_key: 'fixture-key',
  reasoning: {effort: 'high'},
  tools: [{type: 'function', name: 'fixture_tool', parameters: {type: 'object'}}],
  input: [
    {role: 'user', content: [{type: 'input_image', image_url: 'data:image/png;base64,AA=='}]},
    {type: 'configuration_update', reasoning: {effort: 'high'}},
    {type: 'additional_tools', role: 'developer', tools: [{type: 'function', name: 'added_tool'}]},
  ],
}
const probes = requestCapabilityProbes(body)

test('capability probes contain only capabilities and structural paths actually present in the wire request', () => {
  assert.deepEqual(probes, [
    {capability: 'prompt_cache_options', parameters: ['prompt_cache_options', 'prompt_cache_options.mode', 'prompt_cache_options.ttl']},
    {capability: 'configuration_update', parameters: ['input.1', 'input.1.type']},
    {capability: 'additional_tools', parameters: ['input.2', 'input.2.type']},
  ])
  assert.deepEqual(requestCapabilityProbes({input: [body.input[0]], tools: body.tools, reasoning: body.reasoning, prompt_cache_key: 'fixture-key'}), [])
  assert.equal(JSON.stringify(probes).includes('base64'), false)
  assert.equal(JSON.stringify(probes).includes('added_tool'), false)
})

test('only exact unsupported fields or sent enhancement item indices identify a capability', () => {
  for (const param of ['prompt_cache_options', 'prompt_cache_options.ttl']) {
    assert.equal(isUnsupportedParameterError(new ProviderError('unknown_parameter', param, 400), 'prompt_cache_options', probes), true)
  }
  for (const param of ['input[1]', 'input[1].type', 'input.1.type']) {
    const error = new ProviderError('unsupported_value', param, 400)
    assert.equal(isUnsupportedParameterError(error, 'configuration_update', probes), true)
    assert.equal(isUnsupportedParameterError(error, 'additional_tools', probes), false)
  }
  assert.equal(isUnsupportedParameterError(new ProviderError('unsupported_value', 'input[2].type', 400), 'additional_tools', probes), true)
})

test('ordinary images, tools and reasoning validation cannot persistently disable enhancement capabilities', () => {
  const registry = new CapabilityRegistry()
  const unrelated = [
    'input', 'input[0]', 'input[0].type', 'input[0].content[0].image_url', 'tools[0].parameters',
    'reasoning.effort', 'input[1].reasoning.effort', 'input[2].tools[0].parameters',
    'prompt_cache_key', 'prompt_cache_options_extra', 'prompt_cache_options.comparison_response_id',
  ]
  for (const {capability} of probes) {
    registry.record('scope', 'model', capability, 'supported')
    for (const param of unrelated) {
      assert.equal(registry.recordError('scope', 'model', capability, new ProviderError('unsupported_value', param, 400), probes), false, param)
    }
    assert.equal(registry.status('scope', 'model', capability), 'supported')
  }
})

test('ambiguous errors and absent send evidence preserve the existing capability state', () => {
  const registry = new CapabilityRegistry()
  const exact = new ProviderError('unsupported_value', 'input[1].type', 400)
  assert.equal(registry.recordError('scope', 'model', 'configuration_update', exact), false)
  for (const code of ['invalid_value', 'invalid_type', 'invalid_request_error', 'bad_request']) {
    assert.equal(registry.recordError('scope', 'model', 'configuration_update', new ProviderError(code, 'input[1].type', 400), probes), false)
  }
  assert.equal(registry.recordError('scope', 'model', 'configuration_update', new ProviderError('unsupported_value', undefined, 400), probes), false)
  for (const status of [401, 403, 429, 500]) {
    assert.equal(registry.recordError('scope', 'model', 'configuration_update', new ProviderError('unsupported_value', 'input[1].type', status), probes), false)
  }
  assert.equal(registry.status('scope', 'model', 'configuration_update'), 'unknown')
  assert.equal(registry.recordError('scope', 'model', 'configuration_update', exact, probes), true)
  assert.equal(registry.status('scope', 'model', 'configuration_update'), 'unsupported')
})

test('incremental wire bodies use their own input indices and omit unsent enhancement items', () => {
  const incremental = requestCapabilityProbes({input: body.input.slice(2)})
  assert.deepEqual(incremental, [{capability: 'additional_tools', parameters: ['input.0', 'input.0.type']}])
  const error = new ProviderError('unsupported_value', 'input[0].type', 400)
  assert.equal(isUnsupportedParameterError(error, 'additional_tools', incremental), true)
  assert.equal(isUnsupportedParameterError(error, 'configuration_update', incremental), false)
  assert.equal(isUnsupportedParameterError(new ProviderError('unknown_parameter', 'prompt_cache_options', 400), 'prompt_cache_options', incremental), false)
})

test('capability evidence from the previous projection is re-probed without changing replay versions', () => {
  const registry = new CapabilityRegistry()
  registry.hydrate('scope', {model: {
    configuration_update: {status: 'supported', probedAt: 1, projectionVersion: 1},
    additional_tools: {status: 'unsupported', probedAt: 1, projectionVersion: 1},
  }})
  assert.equal(CAPABILITY_PROJECTION_VERSION, 2)
  assert.equal(registry.status('scope', 'model', 'configuration_update'), 'unknown')
  assert.equal(registry.status('scope', 'model', 'additional_tools'), 'unknown')
  assert.equal(registry.isAllowed('scope', 'model', 'additional_tools'), true)
  registry.record('scope', 'model', 'configuration_update', 'supported')
  assert.equal(registry.get('scope', 'model', 'configuration_update').projectionVersion, 2)
})

