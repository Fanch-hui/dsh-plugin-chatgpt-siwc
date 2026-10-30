import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createAssistantMessage, createToolResultMessage, ToolCallId,
  type GenerateOptions, type RequestMessage,
} from '@deepseek-ai/dsh-llm'
import { buildRequest } from '../src/provider/request.js'
import type { WireItem } from '../src/provider/replay.js'

const context = { connectionId: 'fixture-subscription', model: 'fixture-model' }

function apiHistory(ids: readonly string[]): RequestMessage[] {
  return ids.flatMap((id, index) => [
    createAssistantMessage({
      source: { provider: 'openai', model: context.model },
      content: [{ type: 'tool-call', id: ToolCallId(id), name: 'fixture.read', arguments: '{}' }],
    }),
    createToolResultMessage({
      callId: ToolCallId(id), isError: false,
      content: [{ type: 'text', text: `result-${index}` }],
    }),
  ])
}

async function project(messages: RequestMessage[]): Promise<WireItem[]> {
  const options: GenerateOptions = { provider: 'chatgpt-siwc', model: context.model, messages }
  return (await buildRequest(options, context)).body.input as WireItem[]
}

function assertPaired(items: readonly WireItem[], count: number): string[] {
  const calls = items.filter(item => item.type === 'function_call')
  const results = items.filter(item => item.type === 'function_call_output')
  assert.equal(calls.length, count)
  assert.equal(results.length, count)
  const ids = calls.map(call => call.call_id as string)
  assert.equal(new Set(ids).size, count)
  for (let index = 0; index < count; index++) {
    assert.match(ids[index], /^[A-Za-z0-9_-]{1,64}$/)
    assert.equal(results[index].call_id, ids[index])
    assert.deepEqual(results[index].output, [{ type: 'input_text', text: `result-${index}` }])
  }
  return ids
}

test('API Responses history resumes with bounded paired IDs while stored history stays intact', async () => {
  const ids = Array.from({ length: 47 }, (_, index) =>
    `call_${String(index).padStart(24, '0')}|fc_${'a'.repeat(50)}`)
  assert.ok(ids.every(id => id.length === 83))
  const history = apiHistory(ids)
  const stored = JSON.stringify(history)
  const input = await project(history)
  assertPaired(input, ids.length)
  assert.equal(JSON.stringify(history), stored)

  const next = await project([...history, { role: 'user', content: [{ type: 'text', text: 'continue' }] }])
  assert.deepEqual(next.slice(0, input.length), input)
})

test('distinct source IDs stay distinct and standard IDs keep their identity across provider switches', async () => {
  const ids = ['call_fixture', 'x'.repeat(64), 'x'.repeat(65),
    'call_shared|fc_first', 'call_shared|fc_second', 'call/shared', 'call_shared']
  const projected = assertPaired(await project(apiHistory(ids)), ids.length)
  assert.equal(projected[0], ids[0])
  assert.equal(projected[1], ids[1])
  assert.equal(projected[6], ids[6])
})
