import assert from 'node:assert/strict'
import test from 'node:test'
import type { SiwcStatus } from '../src/api/types.js'
import { SiwcController, type RemoteFace } from '../src/client/controller.js'

function status(): SiwcStatus {
  return {authenticated: true, activeAccountId: 'fixture-a', signingIn: false, planEnabled: true,
    availability: 'ready', accounts: [], models: [], authorizedSessions: [], allowBackground: true,
    usage: {requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0}}
}

function fixture() {
  let current = status()
  let refreshes = 0
  const remote = {
    async status() { return {ok: true, value: current} },
    async refreshQuota() { refreshes++; return {ok: true, value: current} },
  } as unknown as RemoteFace
  return {controller: new SiwcController(remote), get refreshes() { return refreshes },
    setStatus(value: SiwcStatus) { current = value }}
}

const settle = () => new Promise<void>(resolve => setImmediate(resolve))

test('quota consumers share one refresh lifecycle and release it when the last consumer leaves', async t => {
  t.mock.timers.enable({apis: ['Date', 'setInterval', 'setTimeout'], now: 0})
  const f = fixture()
  t.after(() => f.controller.dispose())
  const releaseFirst = f.controller.watchQuota()
  const releaseSecond = f.controller.watchQuota()
  assert.equal(f.refreshes, 0)
  await f.controller.run('status')
  await settle()
  assert.equal(f.refreshes, 1)
  t.mock.timers.tick(60_000)
  await settle()
  assert.equal(f.refreshes, 2)
  releaseFirst()
  releaseFirst()
  t.mock.timers.tick(60_000)
  await settle()
  assert.equal(f.refreshes, 3)
  releaseSecond()
  t.mock.timers.tick(60_000)
  await settle()
  assert.equal(f.refreshes, 3)
  const releaseAgain = f.controller.watchQuota()
  await settle()
  assert.equal(f.refreshes, 4)
  f.controller.dispose()
  releaseAgain()
  t.mock.timers.tick(120_000)
  await settle()
  assert.equal(f.refreshes, 4)
})

test('hidden views pause quota refresh; focus and visibility changes respect freshness and account changes', async t => {
  t.mock.timers.enable({apis: ['Date', 'setInterval', 'setTimeout'], now: 0})
  let visibility = 'hidden'
  const documentEvents = new EventTarget()
  Object.defineProperty(documentEvents, 'visibilityState', {get: () => visibility})
  const windowEvents = new EventTarget()
  const globals = globalThis as unknown as Record<string, unknown>
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'document', {configurable: true, value: documentEvents})
  Object.defineProperty(globalThis, 'window', {configurable: true, value: windowEvents})
  const f = fixture()
  t.after(() => {
    f.controller.dispose()
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
    else delete globals.document
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else delete globals.window
  })
  f.controller.watchQuota()
  await f.controller.run('status')
  t.mock.timers.tick(120_000)
  await settle()
  assert.equal(f.refreshes, 0)
  visibility = 'visible'
  documentEvents.dispatchEvent(new Event('visibilitychange'))
  await settle()
  assert.equal(f.refreshes, 1)
  windowEvents.dispatchEvent(new Event('focus'))
  await settle()
  assert.equal(f.refreshes, 1)
  f.setStatus({...status(), activeAccountId: 'fixture-b'})
  await f.controller.run('status')
  await settle()
  assert.equal(f.refreshes, 2)
  await f.controller.run('refreshQuota')
  windowEvents.dispatchEvent(new Event('focus'))
  await settle()
  assert.equal(f.refreshes, 3)
  visibility = 'hidden'
  t.mock.timers.tick(60_000)
  await settle()
  assert.equal(f.refreshes, 3)
  visibility = 'visible'
  windowEvents.dispatchEvent(new Event('focus'))
  await settle()
  assert.equal(f.refreshes, 4)
})

test('sign-in and quota connection work defer automatic quota requests until ready', async t => {
  t.mock.timers.enable({apis: ['Date', 'setInterval', 'setTimeout'], now: 0})
  const f = fixture()
  t.after(() => f.controller.dispose())
  f.setStatus({...status(), signingIn: true})
  f.controller.watchQuota()
  await f.controller.run('status')
  assert.equal(f.refreshes, 0)
  f.setStatus({...status(), quota: {codex: {state: 'connecting'}}})
  await f.controller.run('status')
  assert.equal(f.refreshes, 0)
  f.setStatus(status())
  await f.controller.run('status')
  await settle()
  assert.equal(f.refreshes, 1)
})

test('an in-flight action defers automatic refresh until it completes', async t => {
  t.mock.timers.enable({apis: ['Date', 'setInterval', 'setTimeout'], now: 0})
  let finishAction!: () => void
  const action = new Promise<void>(resolve => { finishAction = resolve })
  let refreshes = 0
  const remote = {
    async status() { return {ok: true, value: status()} },
    async refreshQuota() { refreshes++; return {ok: true, value: status()} },
    async setBackgroundAllowed() { await action; return {ok: true, value: status()} },
  } as unknown as RemoteFace
  const controller = new SiwcController(remote)
  t.after(() => controller.dispose())
  controller.watchQuota()
  await controller.run('status')
  await settle()
  const pending = controller.run('setBackgroundAllowed', false)
  t.mock.timers.tick(60_000)
  await settle()
  assert.equal(refreshes, 1)
  finishAction()
  await pending
  await settle()
  assert.equal(refreshes, 2)
})
