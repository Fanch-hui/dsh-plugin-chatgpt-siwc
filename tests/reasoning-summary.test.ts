import assert from 'node:assert/strict'
import test from 'node:test'
import { BlockAssembler, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { AssistantStreamAccumulator, expandAssistantStream } from '@deepseek-ai/dsh-llm/assistant-stream'
import { classifyWireEvent } from '../src/provider/events.js'
import { buildRequest } from '../src/provider/request.js'
import { parseEvents } from '../src/provider/stream.js'

const context = { connectionId: 'fixture-registration', model: 'fixture-model' }
const itemId = 'rs_fixture'
type Event = Record<string, unknown>

function reasoning(summary: string[]) {
  return {
    type: 'reasoning', id: itemId, encrypted_content: 'synthetic-encrypted',
    summary: summary.map(text => ({ type: 'summary_text', text })),
  }
}

function summaryEvent(type: string, summaryIndex: number, value: string): Event {
  const event = { type, item_id: itemId, output_index: 0, summary_index: summaryIndex }
  if (type.endsWith('.delta')) return { ...event, delta: value }
  if (type === 'response.reasoning_summary_text.done') return { ...event, text: value }
  return { ...event, part: { type: 'summary_text', text: value } }
}

async function collect(events: Event[]) {
  async function* source() {
    for (const [sequence_number, event] of events.entries()) yield { ...event, sequence_number }
  }
  const assembler = new BlockAssembler()
  const chunks: StreamChunk[] = []
  for await (const chunk of parseEvents(source(), [], context)) {
    chunks.push(chunk)
    assembler.push(chunk)
  }
  return { assembler, chunks }
}

function responseEvents(events: Event[], native: ReturnType<typeof reasoning>): Event[] {
  return [
    { type: 'response.output_item.added', output_index: 0, item: reasoning([]) },
    ...events,
    { type: 'response.output_item.done', output_index: 0, item: native },
    { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [native] } },
  ]
}

async function replay(assembler: BlockAssembler) {
  const message = assembler.message({ provider: 'chatgpt-siwc', model: context.model, replayState: assembler.replayState })
  return (await buildRequest({ provider: 'chatgpt-siwc', model: context.model, messages: [message] }, context)).body.input
}

function restoreBlocks(chunks: StreamChunk[]) {
  const accumulator = new AssistantStreamAccumulator()
  chunks.forEach((chunk, time) => accumulator.push({ time, chunk }))
  const restored = expandAssistantStream(JSON.parse(JSON.stringify(accumulator.snapshot())))
  const assembler = new BlockAssembler()
  for (const { chunk } of restored) assembler.push(chunk)
  return assembler.blocks()
}

test('separate reasoning summary parts are readable and replay their native item', async () => {
  const first = '**First heading**'
  const second = '**Second heading**'
  const native = reasoning([first, second])
  const { assembler } = await collect(responseEvents([
    summaryEvent('response.reasoning_summary_part.added', 0, ''),
    summaryEvent('response.reasoning_summary_text.delta', 0, first),
    summaryEvent('response.reasoning_summary_text.done', 0, first),
    summaryEvent('response.reasoning_summary_part.done', 0, first),
    summaryEvent('response.reasoning_summary_part.added', 1, ''),
    summaryEvent('response.reasoning_summary_text.delta', 1, second),
    summaryEvent('response.reasoning_summary_text.done', 1, second),
    summaryEvent('response.reasoning_summary_part.done', 1, second),
  ], native))
  assert.deepEqual(assembler.blocks(), [{ type: 'reasoning', text: `${first}\n\n${second}` }])
  assert.deepEqual(await replay(assembler), [native])
})

test('completion events fill a missing reasoning body without duplication and preserve native replay', async () => {
  const heading = '**Planning**'
  const complete = `${heading}\n\nInspect the result and verify the change.`
  const native = reasoning([heading])
  const { assembler } = await collect(responseEvents([
    summaryEvent('response.reasoning_summary_text.delta', 0, heading),
    summaryEvent('response.reasoning_summary_text.done', 0, complete),
    summaryEvent('response.reasoning_summary_part.done', 0, complete),
  ], native))
  assert.deepEqual(assembler.blocks(), [{ type: 'reasoning', text: complete }])
  assert.deepEqual(await replay(assembler), [native])
})

test('completion snapshots correct revised text while preserving a longer streamed summary', async () => {
  const revised = '**Final heading**\n\nThe final reasoning summary.'
  const native = reasoning(['**Final heading**'])
  const corrected = await collect(responseEvents([
    summaryEvent('response.reasoning_summary_text.delta', 0, '**Draft heading**'),
    summaryEvent('response.reasoning_summary_text.done', 0, revised),
    summaryEvent('response.reasoning_summary_part.done', 0, revised),
  ], native))
  assert.deepEqual(corrected.assembler.blocks(), [{ type: 'reasoning', text: revised }])
  assert.deepEqual(restoreBlocks(corrected.chunks), [{ type: 'reasoning', text: revised }])
  assert.deepEqual(await replay(corrected.assembler), [native])

  const complete = '**Planning**\n\nA streamed body.'
  const shorterNative = reasoning(['**Planning**'])
  const preserved = await collect(responseEvents([
    summaryEvent('response.reasoning_summary_text.delta', 0, complete),
    summaryEvent('response.reasoning_summary_text.done', 0, '**Planning**'),
    summaryEvent('response.reasoning_summary_part.done', 0, '**Planning**'),
  ], shorterNative))
  assert.deepEqual(preserved.assembler.blocks(), [{ type: 'reasoning', text: complete }])
  assert.deepEqual(await replay(preserved.assembler), [shorterNative])
})

test('a completed summary without deltas is displayed from its completion event', async () => {
  for (const type of ['response.reasoning_summary_text.done', 'response.reasoning_summary_part.done']) {
    const complete = '**Planning**\n\nInspect the result.'
    const native = reasoning(['**Planning**'])
    const { assembler } = await collect(responseEvents([summaryEvent(type, 0, complete)], native))
    assert.deepEqual(assembler.blocks(), [{ type: 'reasoning', text: complete }], type)
    assert.deepEqual(await replay(assembler), [native], type)
  }
})

test('a native summary can complete a streamed prefix when no summary completion event arrived', async () => {
  const heading = '**Planning**'
  const complete = `${heading}\n\nInspect the result.`
  const native = reasoning([complete])
  const { assembler } = await collect(responseEvents([
    summaryEvent('response.reasoning_summary_text.delta', 0, heading),
  ], native))
  assert.deepEqual(assembler.blocks(), [{ type: 'reasoning', text: complete }])
  assert.deepEqual(await replay(assembler), [native])
})

test('native summary parts without streaming events are retained alongside streamed parts', async () => {
  const first = '**First heading**\n\nA completed streamed part.'
  const second = '**Second heading**\n\nThe part returned with the item.'
  const native = reasoning([first, second])
  const { assembler } = await collect(responseEvents([
    summaryEvent('response.reasoning_summary_text.delta', 0, first),
    summaryEvent('response.reasoning_summary_text.done', 0, first),
  ], native))
  assert.deepEqual(assembler.blocks(), [{ type: 'reasoning', text: `${first}\n\n${second}` }])
  assert.deepEqual(await replay(assembler), [native])
})

test('non-empty completed summaries count as output while empty placeholders do not', async () => {
  for (const type of ['response.reasoning_summary_text.done', 'response.reasoning_summary_part.done']) {
    assert.equal(classifyWireEvent(summaryEvent(type, 0, 'visible')).emitsOutput, true, type)
    assert.equal(classifyWireEvent(summaryEvent(type, 0, '')).emitsOutput, false, type)
  }

  const empty = reasoning([])
  const events = [
    { type: 'response.output_item.added', output_index: 0, item: empty },
    summaryEvent('response.reasoning_summary_text.done', 0, ''),
    summaryEvent('response.reasoning_summary_part.done', 0, ''),
    { type: 'response.output_item.done', output_index: 0, item: empty },
  ]
  const chunks: StreamChunk[] = []
  async function* source() {
    for (const [sequence_number, event] of events.entries()) yield { ...event, sequence_number }
  }
  await assert.rejects(async () => {
    for await (const chunk of parseEvents(source(), [], context)) chunks.push(chunk)
  }, { code: 'SIWC_STREAM_INTERRUPTED' })
  assert.deepEqual(chunks, [])

  const answer = { type: 'message', id: 'msg_fixture', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] }
  const { assembler } = await collect([
    ...events,
    { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [empty, answer] } },
  ])
  assert.deepEqual(assembler.blocks(), [{ type: 'reasoning', text: '' }, { type: 'text', text: 'Done.' }])
  assert.deepEqual(await replay(assembler), [empty, answer])
})
