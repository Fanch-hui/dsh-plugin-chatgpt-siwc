import WebSocket from 'ws'
import type { ConnectionCause, ConnectionDiagnostic, Session, SessionKind } from './types.js'

type Removal = {cause: ConnectionCause; usedAt: number; closeCode?: number}

/** Borrowed sockets never enter the idle cache or get shared by active calls. */
export class SessionPool {
  private readonly sessions = new Set<Session>()
  private readonly removals = new Map<string, Removal>()
  private readonly latestGeneration = new Map<string, number>()
  private readonly timer?: ReturnType<typeof setInterval>
  private closed = false
  private historyEvicted = false
  private useOrder = 0
  private socketSequence = 0
  private networkEpoch = 0
  constructor(
    private readonly maxIdle: number = 32,
    private readonly idleMs?: number,
    private readonly maxAgeMs: number = 50 * 60_000,
    private readonly hardLimitMs: number = 60 * 60_000,
  ) {
    if (idleMs !== undefined) {
      this.timer = setInterval(() => this.prune(), Math.min(idleMs, 30_000))
      this.timer.unref()
    }
  }
  get currentNetworkEpoch(): number { return this.networkEpoch }
  socketAge(session: Session): {wallAge: number; monoAge: number; effectiveAge: number; skewed: boolean} | undefined {
    if (session.openedAt === undefined) return undefined
    const wallAge = elapsed(session.openedAt)
    const monoAge = session.openedMonotonicAt !== undefined
      ? Math.max(0, Math.round(performance.now() - session.openedMonotonicAt))
      : wallAge
    return {wallAge, monoAge, effectiveAge: Math.max(wallAge, monoAge), skewed: Math.abs(wallAge - monoAge) > 60_000}
  }
  checkRotation(session: Session): boolean {
    const age = this.socketAge(session)
    if (!age) return false
    if (age.skewed) session.needsProbe = true
    if (age.effectiveAge >= this.hardLimitMs) {
      session.retireRequested = true
      if (!session.failureCause || session.failureCause === 'planned-rotation') {
        session.failureCause = 'connection-limit'
      }
      return true
    }
    if (age.effectiveAge >= this.maxAgeMs) {
      session.retireRequested = true
      session.failureCause ??= 'planned-rotation'
      return true
    }
    return false
  }
  notifyNetworkChange(): void {
    this.networkEpoch++
    for (const session of this.sessions) {
      if (!session.active) session.needsProbe = true
    }
    this.prune()
  }
  acquire(
    key: string,
    group: string,
    connectionId: string,
    credential: string,
    sessionKind: SessionKind = 'other',
    credentialGeneration?: number,
  ): Session {
    if (this.closed) throw new Error('ChatGPT 连接池已关闭。')
    this.prune()
    let rotated = false
    let outdatedGeneration = false
    if (credentialGeneration !== undefined) {
      const knownGen = this.latestGeneration.get(group) ?? 0
      if (credentialGeneration < knownGen) {
        outdatedGeneration = true
      } else {
        this.latestGeneration.set(group, credentialGeneration)
        for (const session of this.sessions) {
          if (session.group !== group) continue
          const sameCred = session.credential === credential &&
            (session.credentialGeneration === undefined || session.credentialGeneration >= credentialGeneration)
          if (sameCred) continue
          rotated = true
          session.stale = true
          session.retireRequested = true
          session.failureCause = 'credential-rotated'
          if (!session.active) this.remove(session, 'credential-rotated')
        }
      }
    } else {
      for (const session of this.sessions) {
        if (session.group !== group || session.credential === credential) continue
        rotated = true
        session.stale = true
        session.retireRequested = true
        session.failureCause = 'credential-rotated'
        if (!session.active) this.remove(session, 'credential-rotated')
      }
    }
    if (outdatedGeneration) {
      const session: Session = {
        key, group, connectionId, credential, credentialGeneration, sessionKind,
        useOrder: ++this.useOrder, active: true, stale: false, retireRequested: true,
        failureCause: 'credential-rotated', usedAt: Date.now(),
        acquisition: {state: 'new', cause: 'credential-rotated'},
      }
      this.sessions.add(session)
      return session
    }
    const saved = [...this.sessions].find(session => session.key === key && !session.active && !session.stale && !session.retireRequested)
    if (saved) {
      saved.active = true
      saved.sessionKind = sessionKind
      if (credentialGeneration !== undefined) saved.credentialGeneration = credentialGeneration
      saved.useOrder = ++this.useOrder
      this.removals.delete(group)
      const open = saved.socket?.readyState === WebSocket.OPEN
      saved.acquisition = {state: open ? 'reused' : 'new',
        cause: open ? 'unknown' : saved.failureCause ?? (saved.socket ? 'remote-closed' : 'unknown'),
        idleMs: elapsed(saved.usedAt), ...(saved.closeCode === undefined ? {} : {closeCode: saved.closeCode})}
      return saved
    }
    const previous = this.removals.get(group)
    this.removals.delete(group)
    const concurrent = [...this.sessions].some(session => session.key === key && session.active && !session.stale)
    let cause = previous?.cause ?? (this.historyEvicted ? 'unknown' : 'first-use')
    if (concurrent) cause = 'concurrent-call'
    if (rotated) cause = 'credential-rotated'
    const acquisition: ConnectionDiagnostic = {state: 'new', cause,
      ...(previous ? {idleMs: elapsed(previous.usedAt), ...(previous.closeCode === undefined ? {} : {closeCode: previous.closeCode})} : {})}
    const session: Session = {
      key, group, connectionId, credential,
      ...(credentialGeneration === undefined ? {} : {credentialGeneration}),
      sessionKind, useOrder: ++this.useOrder, active: true, stale: false, usedAt: Date.now(), acquisition,
    }
    this.sessions.add(session)
    return session
  }
  connection(session: Session): ConnectionDiagnostic {
    return {...session.acquisition, ...(session.openedAt === undefined ? {} : {ageMs: elapsed(session.openedAt)})}
  }
  attachSocket(session: Session, socket: WebSocket): boolean {
    if (this.closed || !this.sessions.has(session) || (session.stale && session.failureCause !== 'credential-rotated')) {
      session.stale = true
      this.dropSocket(session)
      socket.on('error', () => {})
      socket.terminate()
      return false
    }
    this.dropSocket(session)
    session.socket = socket
    const now = Date.now()
    session.openedAt = now
    session.openedMonotonicAt = performance.now()
    session.lastPongAt = now
    session.socketGeneration = ++this.socketSequence
    session.networkEpoch = this.networkEpoch
    session.needsProbe = false
    const knownGen = this.latestGeneration.get(session.group)
    if (session.credentialGeneration !== undefined && knownGen !== undefined && session.credentialGeneration < knownGen) {
      session.retireRequested = true
      session.failureCause = 'credential-rotated'
    } else if (!(session.retireRequested && session.failureCause === 'credential-rotated')) {
      session.failureCause = undefined
    }
    session.closeCode = undefined
    socket.on('pong', () => { if (session.socket === socket) session.lastPongAt = Date.now() })
    socket.on('error', () => { if (session.socket === socket) session.failureCause = 'socket-error' })
    socket.once('close', code => {
      if (session.socket !== socket) return
      session.cleanupSocket?.()
      session.cleanupSocket = undefined
      session.failureCause ??= 'remote-closed'
      if (Number.isInteger(code) && code >= 1000 && code <= 4999) session.closeCode = code
      session.baseline = undefined
      if (!session.active) this.remove(session, session.failureCause)
    })
    return true
  }
  release(session: Session, keep: boolean, cause: ConnectionCause = 'request-failed'): void {
    session.active = false
    session.usedAt = Date.now()
    session.useOrder = ++this.useOrder
    this.checkRotation(session)
    if (!keep || session.stale || session.retireRequested || this.closed || (session.socket && session.socket.readyState !== WebSocket.OPEN)) {
      this.remove(session, session.failureCause ?? (session.retireRequested ? 'planned-rotation' : cause))
    } else this.retainLatest(session.group)
    this.prune()
  }
  invalidate(connectionId?: string): void {
    if (connectionId === undefined) this.latestGeneration.clear()
    for (const session of this.sessions) {
      if (connectionId === undefined || session.connectionId === connectionId) {
        this.latestGeneration.delete(session.group)
        this.remove(session, 'invalidated')
      }
    }
  }
  dispose(): void { this.closed = true; clearInterval(this.timer); this.invalidate(); this.removals.clear() }
  private dropSocket(session: Session): void {
    session.cleanupSocket?.()
    session.cleanupSocket = undefined
    session.baseline = undefined
    const socket = session.socket
    session.socket = undefined
    if (socket) { socket.on('error', () => {}); socket.terminate() }
  }
  private remove(session: Session, cause: ConnectionCause): void {
    if (!this.sessions.delete(session)) {
      this.dropSocket(session)
      return
    }
    this.dropSocket(session)
    const hasNewer = session.credentialGeneration !== undefined &&
      session.credentialGeneration < (this.latestGeneration.get(session.group) ?? 0)
    if (!hasNewer) {
      this.removals.delete(session.group)
      this.removals.set(session.group, {cause, usedAt: session.usedAt,
        ...(session.closeCode === undefined ? {} : {closeCode: session.closeCode})})
      while (this.removals.size > 256) {
        this.removals.delete(this.removals.keys().next().value!)
        this.historyEvicted = true
      }
    }
    session.stale = true
  }
  private retainLatest(group: string): void {
    const idle = [...this.sessions].filter(session => session.group === group && !session.active && !session.stale && !session.retireRequested)
    const eligible = idle.filter(session => session.baseline)
    const candidates = eligible.length ? eligible : idle
    const newest = candidates.reduce<Session | undefined>((latest, session) =>
      !latest || session.useOrder > latest.useOrder ? session : latest, undefined)
    for (const session of idle) if (session !== newest) this.remove(session, 'duplicate-idle')
  }
  private prune(): void {
    for (const session of this.sessions) {
      if (session.active) this.checkRotation(session)
    }
    const idle = [...this.sessions].filter(session => !session.active).sort((a, b) => a.useOrder - b.useOrder)
    for (const session of idle) {
      this.checkRotation(session)
      const expired = this.idleMs !== undefined && elapsed(session.usedAt) >= this.idleMs
      if (session.stale || session.retireRequested || expired) {
        this.remove(session, session.failureCause ?? (session.retireRequested ? 'planned-rotation' : 'idle-expired'))
      }
    }
    const retained = idle.filter(session => this.sessions.has(session))
    let excess = retained.length - this.maxIdle
    if (excess <= 0) return
    const protectedGroups = new Set(retained.filter(session => session.sessionKind === 'conversation')
      .reverse().slice(0, Math.min(8, this.maxIdle)).map(session => session.group))
    for (const session of retained) {
      if (excess <= 0) break
      if (protectedGroups.has(session.group)) continue
      this.remove(session, 'capacity-evicted')
      excess--
    }
  }
}

function elapsed(since: number): number { return Math.max(0, Date.now() - since) }
