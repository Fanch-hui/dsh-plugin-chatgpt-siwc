import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { confirmedResponses } from '../src/provider/durability.js'

const replayContext = { connectionId: 'fixture-registration', model: 'fixture-model', sessionId: 'fixture-wire-session' }
const message = () => createAssistantMessage({ content: [{type: 'text', text: 'saved output'}],
  source: {provider: 'chatgpt-siwc', model: replayContext.model,
    replayState: {response: {...replayContext, version: 2, responseId: 'response-fixture'}, blocks: []}} })

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create(SessionId('durability-fixture'))
  const assistant = message()
  session.append('assistant/message', {turn: 1, step: 1, message: assistant, stream: []}, {surfaceOp: 'append'})
  const options: GenerateOptions = {provider: 'chatgpt-siwc', model: replayContext.model, sessionId: session.id, messages: [assistant]}
  return {ctx, session, assistant, options}
}

test('DSH durability barrier must complete before a response becomes eligible for continuation', async () => {
  const {ctx, options} = await setup()
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  ctx.on('session/flush', async () => { await barrier })
  try {
    let confirmed = false
    const pending = confirmedResponses(ctx.sessions, options, replayContext).then(value => { confirmed = true; return value })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(confirmed, false)
    release()
    assert.deepEqual([...(await pending)], ['response-fixture'])
  } finally { await ctx.fiber.dispose() }
})

test('missing durability provider and failed persistence never confirm a response', async () => {
  const {ctx, options} = await setup()
  try {
    assert.equal((await confirmedResponses(ctx.sessions, options, replayContext)).size, 0)
    ctx.on('session/flush', () => { throw new Error('fixture disk failure') })
    await assert.rejects(confirmedResponses(ctx.sessions, options, replayContext), /fixture disk failure/)
  } finally { await ctx.fiber.dispose() }
})

test('only the exact current durable content and registration can confirm a response', async () => {
  const {ctx, options, assistant} = await setup()
  ctx.on('session/flush', () => {})
  try {
    const changed = {...options, messages: [{...assistant, content: [{type: 'text' as const, text: 'edited output'}]}]}
    assert.equal((await confirmedResponses(ctx.sessions, changed, replayContext)).size, 0)
    assert.equal((await confirmedResponses(ctx.sessions, options, {...replayContext, connectionId: 'other'})).size, 0)
    assert.equal((await confirmedResponses(ctx.sessions, {...options, sessionId: SessionId('missing')}, replayContext)).size, 0)
    const cancelled = new AbortController()
    cancelled.abort()
    await assert.rejects(confirmedResponses(ctx.sessions, {...options, signal: cancelled.signal}, replayContext), {name: 'AbortError'})
  } finally { await ctx.fiber.dispose() }
})

test('durability diagnostics distinguish absent candidates, failed flush and changed history', async () => {
  const {ctx, options, assistant} = await setup()
  const observed: {reason: string; candidates: number; confirmed: number}[] = []
  const observe = (value: typeof observed[number]) => { observed.push(value) }
  try {
    await confirmedResponses(ctx.sessions, {...options, messages: []}, replayContext, observe)
    await confirmedResponses(ctx.sessions, options, replayContext, observe)
    ctx.on('session/flush', () => {})
    await confirmedResponses(ctx.sessions, {...options, messages: [{...assistant, content: [{type: 'text', text: 'changed'}]}]}, replayContext, observe)
    await confirmedResponses(ctx.sessions, options, replayContext, observe)
    assert.deepEqual(observed, [
      {reason: 'no-candidate', candidates: 0, confirmed: 0}, {reason: 'flush-failed', candidates: 1, confirmed: 0},
      {reason: 'history-mismatch', candidates: 1, confirmed: 0}, {reason: 'confirmed', candidates: 1, confirmed: 1},
    ])
    assert.equal((await confirmedResponses(ctx.sessions, options, replayContext, () => { throw new Error('observer') })).size, 1)
  } finally { await ctx.fiber.dispose() }
})

test('durability supports v3 replayScope/wireSessionId, candidateResponseIds filtering, and WeakMap serialization caching', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  let flushCalls = 0
  ctx.on('session/flush', () => { flushCalls++ })
  try {
    const session = ctx.sessions.create(SessionId('durability-v3-fixture'))
    let contentReads = 0
    const v3Context = {
      connectionId: 'acct-a:1',
      replayScope: 'scope-a-epoch-1',
      model: 'fixture-model',
      wireSessionId: 'wire-session-v3',
    }
    const first = createAssistantMessage({
      content: [{ type: 'text', text: 'first response' }],
      source: {
        provider: 'chatgpt-siwc',
        model: v3Context.model,
        replayState: {
          response: { ...v3Context, version: 3, responseId: 'resp-v3-1' },
          blocks: [],
        },
      },
    })
    const second = createAssistantMessage({
      content: [{ type: 'text', text: 'second response' }],
      source: {
        provider: 'chatgpt-siwc',
        model: v3Context.model,
        replayState: {
          response: { ...v3Context, version: 3, responseId: 'resp-v3-2' },
          blocks: [],
        },
      },
    })
    session.append('assistant/message', { turn: 1, step: 1, message: first, stream: [] }, { surfaceOp: 'append' })
    session.append('assistant/message', { turn: 2, step: 1, message: second, stream: [] }, { surfaceOp: 'append' })
    const proxiedContent = new Proxy(first.content, {
      get(target, prop, receiver) {
        if (prop === '0') contentReads++
        return Reflect.get(target, prop, receiver)
      },
    })
    const firstWithProxy = { ...first, content: proxiedContent }
    const options: GenerateOptions = {
      provider: 'chatgpt-siwc',
      model: v3Context.model,
      sessionId: session.id,
      messages: [firstWithProxy, second],
    }

    // Confirm across connectionId rotation when replayScope and wireSessionId match
    const rotatedContext = { ...v3Context, connectionId: 'acct-a:5' }
    const onlySecond = await confirmedResponses(ctx.sessions, options, rotatedContext, undefined, new Set(['resp-v3-2']))
    assert.deepEqual([...onlySecond], ['resp-v3-2'])
    assert.equal(flushCalls, 1)
    assert.equal(contentReads, 0) // first was skipped because candidateResponseIds only requested resp-v3-2

    // Absent candidateResponseIds skips flush entirely
    const absent = await confirmedResponses(ctx.sessions, options, rotatedContext, undefined, new Set(['resp-missing']))
    assert.equal(absent.size, 0)
    assert.equal(flushCalls, 1)

    // Repeated confirmation of unchanged messages reuses WeakMap serialization cache
    const allFirstRun = await confirmedResponses(ctx.sessions, options, rotatedContext)
    assert.deepEqual([...allFirstRun], ['resp-v3-1', 'resp-v3-2'])
    const readsAfterFirst = contentReads
    assert.equal(readsAfterFirst > 0, true)
    const allSecondRun = await confirmedResponses(ctx.sessions, options, rotatedContext)
    assert.deepEqual([...allSecondRun], ['resp-v3-1', 'resp-v3-2'])
    assert.equal(contentReads, readsAfterFirst)
  } finally {
    await ctx.fiber.dispose()
  }
})
