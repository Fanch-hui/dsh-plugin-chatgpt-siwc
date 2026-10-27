import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type WebSocket from 'ws'
import { SessionPool } from '../src/provider/transport/pool.js'
import { probeSocket, startHeartbeat } from '../src/provider/transport/socket.js'

test('default pool retains more than sixteen idle sessions without a time limit', t => {
  const pool = new SessionPool()
  try {
    const saved = Array.from({length: 24}, (_, i) => {
      const session = pool.acquire(`s${i}`, `g${i}`, 'connection', 'fixture')
      pool.release(session, true)
      return session
    })
    const future = Date.now() + 24 * 60 * 60_000
    t.mock.method(Date, 'now', () => future)
    saved.forEach((session, i) => {
      assert.equal(pool.acquire(`s${i}`, `g${i}`, 'connection', 'fixture'), session)
      pool.release(session, true)
    })
  } finally { pool.dispose() }
})

test('remote socket closure releases an idle session and its continuation baseline', () => {
  const pool = new SessionPool()
  const socket = Object.assign(new EventEmitter(), {readyState: 1, terminate() { this.readyState = 3 }})
  try {
    const session = pool.acquire('s', 'g', 'connection', 'fixture')
    session.baseline = {responseId: 'response', settings: 'hash', items: ['hash']}
    pool.attachSocket(session, socket as unknown as WebSocket)
    pool.release(session, true)
    socket.readyState = 3
    socket.emit('close')
    assert.equal(session.baseline, undefined)
    assert.equal(session.socket, undefined)
    assert.notEqual(pool.acquire('s', 'g', 'connection', 'fixture'), session)
  } finally { pool.dispose() }
})

function socket() {
  return Object.assign(new EventEmitter(), {readyState: 1, terminate() { this.readyState = 3 }})
}

test('connection diagnostics identify idle reuse, credential rotation and concurrent calls', t => {
  const pool = new SessionPool()
  let now = 1000
  t.mock.method(Date, 'now', () => now)
  try {
    const first = pool.acquire('one', 'group', 'connection', 'credential-a')
    assert.deepEqual(pool.connection(first), {state: 'new', cause: 'first-use'})
    pool.attachSocket(first, socket() as unknown as WebSocket)
    now = 2000
    pool.release(first, true)
    now = 7000
    const resumed = pool.acquire('one', 'group', 'connection', 'credential-a')
    assert.equal(resumed, first)
    assert.deepEqual(pool.connection(resumed), {state: 'reused', cause: 'unknown', idleMs: 5000, ageMs: 6000})
    const concurrent = pool.acquire('one', 'group', 'connection', 'credential-a')
    assert.equal(pool.connection(concurrent).cause, 'concurrent-call')
    const rotated = pool.acquire('two', 'group', 'connection', 'credential-b')
    assert.equal(pool.connection(rotated).cause, 'credential-rotated')
  } finally { pool.dispose() }
})

test('closed connections retain only numeric close information and bounded causes', () => {
  const pool = new SessionPool()
  try {
    const first = pool.acquire('one', 'group', 'connection', 'fixture')
    const remote = socket()
    pool.attachSocket(first, remote as unknown as WebSocket)
    pool.release(first, true)
    remote.readyState = 3
    remote.emit('close', 1001, Buffer.from('private close explanation'))
    const afterClose = pool.acquire('one', 'group', 'connection', 'fixture')
    assert.equal(pool.connection(afterClose).cause, 'remote-closed')
    assert.equal(pool.connection(afterClose).closeCode, 1001)
    assert.doesNotMatch(JSON.stringify(pool.connection(afterClose)), /private/)
    const failed = socket()
    pool.attachSocket(afterClose, failed as unknown as WebSocket)
    pool.release(afterClose, true)
    failed.emit('error', new Error('private network detail'))
    failed.readyState = 3
    failed.emit('close', 1006)
    const afterError = pool.acquire('one', 'group', 'connection', 'fixture')
    assert.equal(pool.connection(afterError).cause, 'socket-error')
    pool.release(afterError, false, 'cancelled')
    const afterCancel = pool.acquire('one', 'group', 'connection', 'fixture')
    assert.equal(pool.connection(afterCancel).cause, 'cancelled')
    pool.invalidate('connection')
    assert.equal(pool.connection(pool.acquire('one', 'group', 'connection', 'fixture')).cause, 'invalidated')
  } finally { pool.dispose() }
})

test('explicit idle and capacity policies retain distinct rebuild causes', t => {
  let now = 1000
  t.mock.method(Date, 'now', () => now)
  const expiry = new SessionPool(undefined, 100)
  const capacity = new SessionPool(1)
  try {
    const first = expiry.acquire('one', 'group', 'connection', 'fixture')
    expiry.release(first, true)
    now = 1200
    assert.equal(expiry.connection(expiry.acquire('one', 'group', 'connection', 'fixture')).cause, 'idle-expired')
    const a = capacity.acquire('a', 'group-a', 'connection', 'fixture')
    capacity.release(a, true)
    const b = capacity.acquire('b', 'group-b', 'connection', 'fixture')
    capacity.release(b, true)
    assert.equal(capacity.connection(capacity.acquire('a', 'group-a', 'connection', 'fixture')).cause, 'capacity-evicted')
  } finally { expiry.dispose(); capacity.dispose() }
})

test('rebuild history retains the most recent 256 session groups', () => {
  const pool = new SessionPool()
  try {
    for (let i = 0; i < 257; i++) {
      const session = pool.acquire(`s${i}`, `g${i}`, 'connection', 'fixture')
      pool.release(session, false, 'cancelled')
    }
    assert.equal(pool.connection(pool.acquire('s0', 'g0', 'connection', 'fixture')).cause, 'unknown')
    assert.equal(pool.connection(pool.acquire('s256', 'g256', 'connection', 'fixture')).cause, 'cancelled')
  } finally { pool.dispose() }
})

function idleSession(pool: SessionPool, id: string, kind: 'conversation' | 'subagent' | 'other' = 'other') {
  const session = pool.acquire(id, id, 'connection', 'fixture', kind)
  pool.attachSocket(session, socket() as unknown as WebSocket)
  pool.release(session, true)
  return session
}

test('default idle budget retains thirty-two connections and leaves active requests untouched', () => {
  const pool = new SessionPool()
  try {
    const active = Array.from({length: 40}, (_, i) => {
      const session = pool.acquire(`active-${i}`, `active-${i}`, 'connection', 'fixture', 'subagent')
      pool.attachSocket(session, socket() as unknown as WebSocket)
      return session
    })
    const idle = Array.from({length: 40}, (_, i) => idleSession(pool, `idle-${i}`, 'subagent'))
    assert.ok(active.every(session => session.active && !session.stale && session.socket?.readyState === 1))
    assert.ok(idle.slice(0, 8).every(session => session.stale))
    assert.ok(idle.slice(8).every(session => !session.stale))
    const recycled = pool.acquire('idle-0', 'idle-0', 'connection', 'fixture')
    assert.equal(pool.connection(recycled).cause, 'capacity-evicted')
  } finally { pool.dispose() }
})

test('idle budget protects the eight most recently used main conversations and recycles other groups by recency', () => {
  const pool = new SessionPool()
  try {
    const main = Array.from({length: 9}, (_, i) => idleSession(pool, `main-${i}`, 'conversation'))
    const children = Array.from({length: 32}, (_, i) => idleSession(pool, `child-${i}`, 'subagent'))
    assert.equal(main[0].stale, true)
    assert.ok(main.slice(1).every(session => !session.stale))
    assert.ok(children.slice(0, 8).every(session => session.stale))
    assert.ok(children.slice(8).every(session => !session.stale))
  } finally { pool.dispose() }
})

test('unused main protection seats remain available to other idle connections', () => {
  const pool = new SessionPool()
  try {
    const main = [idleSession(pool, 'main-a', 'conversation'), idleSession(pool, 'main-b', 'conversation')]
    const children = Array.from({length: 32}, (_, i) => idleSession(pool, `child-${i}`, 'subagent'))
    assert.ok(main.every(session => !session.stale))
    assert.ok(children.slice(0, 2).every(session => session.stale))
    assert.ok(children.slice(2).every(session => !session.stale))
  } finally { pool.dispose() }
})

test('parallel completion retains the latest eligible continuation and clears redundant idle sockets', () => {
  const pool = new SessionPool()
  try {
    const first = pool.acquire('same', 'same', 'connection', 'fixture', 'conversation')
    const second = pool.acquire('same', 'same', 'connection', 'fixture', 'conversation')
    const third = pool.acquire('same', 'same', 'connection', 'fixture', 'conversation')
    for (const session of [first, second, third]) pool.attachSocket(session, socket() as unknown as WebSocket)
    first.baseline = {responseId: 'earlier', settings: 'hash', items: ['one']}
    second.baseline = {responseId: 'latest', settings: 'hash', items: ['one', 'two']}
    pool.release(first, true)
    pool.release(second, true)
    assert.equal(first.stale, true)
    assert.equal(first.socket, undefined)
    assert.equal(third.active, true)
    assert.equal(third.stale, false)
    pool.release(third, true)
    assert.equal(third.stale, true)
    const resumed = pool.acquire('same', 'same', 'connection', 'fixture', 'conversation')
    assert.equal(resumed, second)
    assert.equal(resumed.baseline?.responseId, 'latest')
    assert.equal(pool.connection(resumed).state, 'reused')
  } finally { pool.dispose() }
})

test('explicit zero idle capacity also releases protected main conversations', () => {
  const pool = new SessionPool(0)
  try { assert.equal(idleSession(pool, 'main', 'conversation').stale, true) }
  finally { pool.dispose() }
})

test('token generation race: late older generation does not evict newer idle socket and late old handshake retires on release', () => {
  const pool = new SessionPool()
  try {
    const gen8 = pool.acquire('k8', 'group-a', 'connection', 'cred-8', 'conversation', 8)
    const sock8 = socket()
    assert.equal(pool.attachSocket(gen8, sock8 as unknown as WebSocket), true)
    gen8.baseline = {responseId: 'resp-8', settings: 'hash', items: ['one']}
    pool.release(gen8, true)

    const lateGen7 = pool.acquire('k7', 'group-a', 'connection', 'cred-7', 'conversation', 7)
    assert.equal(lateGen7.retireRequested, true)
    assert.equal(pool.connection(lateGen7).cause, 'credential-rotated')
    const sock7 = socket()
    assert.equal(pool.attachSocket(lateGen7, sock7 as unknown as WebSocket), true)
    pool.release(lateGen7, true)
    assert.equal(lateGen7.stale, true)
    assert.equal(lateGen7.socket, undefined)
    assert.equal(sock7.readyState, 3)
    assert.equal(gen8.stale, false)
    assert.equal(gen8.socket, sock8)

    const resumed8 = pool.acquire('k8', 'group-a', 'connection', 'cred-8', 'conversation', 8)
    assert.equal(resumed8, gen8)
    assert.equal(pool.connection(resumed8).state, 'reused')
    pool.release(resumed8, true)

    const inflight7 = pool.acquire('k7-b', 'group-b', 'connection', 'cred-7', 'conversation', 7)
    const newer8 = pool.acquire('k8-b', 'group-b', 'connection', 'cred-8', 'conversation', 8)
    const newerSock8 = socket()
    assert.equal(pool.attachSocket(newer8, newerSock8 as unknown as WebSocket), true)
    newer8.baseline = {responseId: 'resp-b8', settings: 'hash', items: ['one']}
    pool.release(newer8, true)

    const lateHandshakeSock7 = socket()
    assert.equal(pool.attachSocket(inflight7, lateHandshakeSock7 as unknown as WebSocket), true)
    assert.equal(inflight7.retireRequested, true)
    pool.release(inflight7, true)
    assert.equal(inflight7.stale, true)
    assert.equal(lateHandshakeSock7.readyState, 3)
    assert.equal(newer8.stale, false)
    assert.equal(newer8.socket, newerSock8)
    assert.equal(pool.connection(pool.acquire('k8-b', 'group-b', 'connection', 'cred-8', 'conversation', 8)).state, 'reused')
  } finally { pool.dispose() }
})

test('late handshake completing after pool.invalidate closes the new socket immediately and never leaves it OPEN', () => {
  const pool = new SessionPool()
  try {
    const inflight = pool.acquire('k-inv', 'group-inv', 'connection', 'fixture', 'conversation')
    pool.invalidate('connection')
    assert.equal(inflight.stale, true)
    const lateSocket = socket()
    assert.equal(pool.attachSocket(inflight, lateSocket as unknown as WebSocket), false)
    assert.equal(lateSocket.readyState, 3)
    assert.equal(inflight.socket, undefined)
    pool.release(inflight, true)
    assert.equal(inflight.socket, undefined)
  } finally { pool.dispose() }
})

test('socket lifetime: 50m planned rotation, active draining across 50m, 60m hard limit, and network change probe', t => {
  const pool = new SessionPool()
  let now = 1_000, mono = 1_000
  t.mock.method(Date, 'now', () => now)
  t.mock.method(performance, 'now', () => mono)
  try {
    const s1 = pool.acquire('k1', 'g1', 'connection', 'fixture', 'conversation')
    pool.attachSocket(s1, socket() as unknown as WebSocket)
    pool.release(s1, true)
    now += 50 * 60_000; mono += 50 * 60_000
    const s1Rotated = pool.acquire('k1', 'g1', 'connection', 'fixture', 'conversation')
    assert.notEqual(s1Rotated, s1)
    assert.equal(s1.stale, true)
    assert.equal(pool.connection(s1Rotated).cause, 'planned-rotation')
    pool.release(s1Rotated, false)

    const active = pool.acquire('k2', 'g2', 'connection', 'fixture', 'conversation')
    const activeSock = socket()
    pool.attachSocket(active, activeSock as unknown as WebSocket)
    now += 52 * 60_000; mono += 52 * 60_000
    assert.equal(pool.checkRotation(active), true)
    assert.equal(active.retireRequested, true)
    assert.equal(activeSock.readyState, 1)
    pool.release(active, true)
    assert.equal(active.stale, true)
    assert.equal(activeSock.readyState, 3)
    const afterDrain = pool.acquire('k2', 'g2', 'connection', 'fixture', 'conversation')
    assert.equal(pool.connection(afterDrain).cause, 'planned-rotation')
    pool.release(afterDrain, false)

    const s3 = pool.acquire('k3', 'g3', 'connection', 'fixture', 'conversation')
    pool.attachSocket(s3, socket() as unknown as WebSocket)
    pool.release(s3, true)
    now += 60 * 60_000; mono += 60 * 60_000
    const s3Limit = pool.acquire('k3', 'g3', 'connection', 'fixture', 'conversation')
    assert.notEqual(s3Limit, s3)
    assert.equal(pool.connection(s3Limit).cause, 'connection-limit')
    pool.release(s3Limit, false)

    const s4 = pool.acquire('k4', 'g4', 'connection', 'fixture', 'conversation')
    pool.attachSocket(s4, socket() as unknown as WebSocket)
    pool.release(s4, true)
    assert.equal(s4.needsProbe, false)
    pool.notifyNetworkChange()
    assert.equal(s4.needsProbe, true)
  } finally { pool.dispose() }
})

test('probeSocket and startHeartbeat detect pong responses and timeout on blackholed sockets', async () => {
  const emitter = new EventEmitter()
  const healthySock = Object.assign(emitter, {readyState: 1, ping() { setImmediate(() => emitter.emit('pong')) }})
  assert.equal(await probeSocket(healthySock as unknown as WebSocket, 50), true)
  const deadSock = Object.assign(new EventEmitter(), {readyState: 1, ping() {}})
  assert.equal(await probeSocket(deadSock as unknown as WebSocket, 15), false)
  let unhealthyCount = 0
  const stop = startHeartbeat(deadSock as unknown as WebSocket, 10, 10, () => { unhealthyCount++ })
  await new Promise(resolve => setTimeout(resolve, 35))
  stop()
  assert.equal(unhealthyCount, 1)
})
