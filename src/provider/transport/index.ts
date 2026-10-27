import { createHash } from 'node:crypto'
import WebSocket from 'ws'
import { checkResponse } from '../errors.js'
import { classifyWireEvent } from '../events.js'
import { readResponseEvents } from '../sse.js'
import { SessionPool } from './pool.js'
import { connectSocket, probeSocket, protectSocket, socketEvents, SocketInterrupted, startHeartbeat } from './socket.js'
import { createAttemptBudget } from './types.js'
import type { AttemptBudget, Baseline, DisconnectDiagnostic, Session, TransportDecision, TransportOptions, TransportRequest, WireEvent } from './types.js'

export { createAttemptBudget } from './types.js'
export type { AttemptBudget, TransportDecision, TransportOptions, TransportRequest, WireEvent, SocketFactory, ConnectionDiagnostic, ConnectionCause, DisconnectCause, DisconnectDiagnostic } from './types.js'

function fingerprint(value: unknown): string {
  const stable = JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
  return createHash('sha256').update(stable).digest('hex')
}
function fullBody(body: Record<string, unknown>): Record<string, unknown> {
  const {stream: _stream, background: _background, previous_response_id: _previous, ...rest} = body
  return {...rest, store: false}
}
function semanticSettings(full: Record<string, unknown>): Record<string, unknown> {
  const {input: _input, prompt_cache_options: cacheOpts, ...settings} = full
  if (cacheOpts && typeof cacheOpts === 'object' && !Array.isArray(cacheOpts)) {
    const {comparison_response_id: _cmp, ...restCacheOpts} = cacheOpts as Record<string, unknown>
    return Object.keys(restCacheOpts).length > 0 ? {...settings, prompt_cache_options: restCacheOpts} : settings
  }
  return cacheOpts === undefined ? settings : {...settings, prompt_cache_options: cacheOpts}
}
function failureCode(event: WireEvent): string | undefined {
  const response = event.response as WireEvent | undefined
  const error = (event.error ?? response?.error) as WireEvent | undefined
  return typeof error?.code === 'string' ? error.code : typeof event.code === 'string' ? event.code : undefined
}

function decide(cold: boolean, previous: Baseline | undefined, confirmed: ReadonlySet<string> | undefined,
  settings: string, hashes: string[]): TransportDecision {
  if (cold) return {mode: 'ws-full', reason: 'cold-connection'}
  if (!previous) return {mode: 'ws-full', reason: 'no-baseline'}
  if (!confirmed?.has(previous.responseId)) return {mode: 'ws-full', reason: 'unconfirmed-response'}
  if (previous.settings !== settings) return {mode: 'ws-full', reason: 'settings-changed'}
  const difference = previous.items.findIndex((hash, index) => hashes[index] !== hash)
  if (difference !== -1) return {mode: 'ws-full', reason: 'prefix-changed', firstDifference: difference}
  return {mode: 'ws-incremental', reason: 'continued'}
}
function notifyRequestBody(request: TransportRequest, body: Record<string, unknown>): void {
  try { request.onRequestBody?.(body) } catch { /* Observation is independent of transport. */ }
}
function notifyDecision(request: TransportRequest, decision: TransportDecision): void {
  // Diagnostic observers cannot change request delivery or retry behavior.
  try { request.onDecision?.(decision) } catch { /* Observation is independent of transport. */ }
}
function notifyDisconnect(request: TransportRequest, disconnect: DisconnectDiagnostic): void {
  try { request.onDisconnect?.(disconnect) } catch { /* Observation is independent of transport. */ }
}
function notifyTiming(
  request: TransportRequest,
  stage: 'handshake-start' | 'handshake-end' | 'request-sent' | 'first-event',
  timestamp: number = Date.now(),
): void {
  try { request.onTiming?.(stage, timestamp) } catch { /* Observation is independent of transport. */ }
}

export class ResponsesTransport {
  private readonly pool: SessionPool
  private readonly socketFactory: NonNullable<TransportOptions['socketFactory']>
  private readonly lifetime = new AbortController()
  private consecutiveFailures = 0
  private cooldownUntil = 0
  private probing = false
  constructor(private readonly options: TransportOptions) {
    this.pool = new SessionPool(options.maxIdle, options.idleMs, options.maxAgeMs, options.hardLimitMs)
    this.socketFactory = options.socketFactory ?? connectSocket
  }
  dispose(): void { this.lifetime.abort(); this.pool.dispose() }
  invalidate(connectionId?: string): void { this.pool.invalidate(connectionId) }
  notifyNetworkChange(): void { this.pool.notifyNetworkChange(); this.cooldownUntil = 0 }
  private recordCooldownFailure(): void {
    this.consecutiveFailures++
    const base = this.options.cooldownBaseMs ?? 30_000
    const max = this.options.cooldownMaxMs ?? 5 * 60_000
    this.cooldownUntil = Date.now() + Math.min(max, base * 2 ** (this.consecutiveFailures - 1))
  }

  async *stream(request: TransportRequest): AsyncGenerator<WireEvent> {
    const signal = AbortSignal.any([this.lifetime.signal, ...(request.signal ? [request.signal] : [])])
    signal.throwIfAborted()
    const budget = request.budget ?? createAttemptBudget()
    const group = fingerprint([request.connectionId, request.sessionId])
    const credential = fingerprint(request.accessToken)
    const key = fingerprint([group, credential, ...(request.credentialGeneration === undefined ? [] : [request.credentialGeneration])])
    const session = this.pool.acquire(key, group, request.connectionId, credential, request.sessionKind, request.credentialGeneration)
    const headers = {...this.options.headers, authorization: `Bearer ${request.accessToken}`, 'session-id': request.sessionId}
    let completed = false, observed = false, probing = false, handshakeSucceeded = false, attemptEvents = 0
    let lastEventType: string | undefined, lastEventSequence: number | undefined
    try {
      try {
        let cold = session.socket?.readyState !== WebSocket.OPEN
        if (!cold) {
          const age = this.pool.socketAge(session)
          const probeIdleMs = this.options.probeIdleMs ?? 30_000
          const idleExceeded = session.acquisition.idleMs !== undefined && session.acquisition.idleMs >= probeIdleMs
          const epochChanged = session.networkEpoch !== undefined && session.networkEpoch !== this.pool.currentNetworkEpoch
          if (session.needsProbe || epochChanged || idleExceeded || age?.skewed) {
            const healthy = await probeSocket(session.socket!, this.options.pongTimeoutMs ?? 10_000, signal)
            signal.throwIfAborted()
            if (!healthy) {
              session.cleanupSocket?.()
              session.cleanupSocket = undefined
              const oldSocket = session.socket
              session.socket = undefined
              session.baseline = undefined
              oldSocket?.on('error', () => {})
              oldSocket?.terminate()
              session.failureCause = 'health-check-failed'
              session.acquisition = {state: 'new', cause: 'health-check-failed',
                ...(session.acquisition.idleMs === undefined ? {} : {idleMs: session.acquisition.idleMs})}
              cold = true
            } else {
              session.needsProbe = false
              session.networkEpoch = this.pool.currentNetworkEpoch
              session.lastPongAt = Date.now()
            }
          }
        }
        if (cold) {
          session.baseline = undefined
          if (this.probing || (this.consecutiveFailures > 0 && Date.now() < this.cooldownUntil)) {
            yield* this.streamHttp(request, session, headers, signal, budget, 'ws-cooldown')
            return
          }
          if (budget.handshakesUsed >= budget.maxHandshakes) throw new SocketInterrupted({cause: 'handshake-failed'})
          if (this.consecutiveFailures > 0) { this.probing = true; probing = true }
          budget.handshakesUsed++
          notifyTiming(request, 'handshake-start')
          let rawSocket: WebSocket
          try {
            rawSocket = await this.socketFactory(headers, signal)
          } catch (err) {
            if (probing) { this.probing = false; probing = false }
            if (!signal.aborted) this.recordCooldownFailure()
            throw err
          }
          handshakeSucceeded = true
          notifyTiming(request, 'handshake-end')
          const socket = protectSocket(rawSocket)
          if (!this.pool.attachSocket(session, socket)) throw new SocketInterrupted({cause: 'remote-closed'})
          session.cleanupSocket = startHeartbeat(socket, this.options.pingIntervalMs ?? 30_000, this.options.pongTimeoutMs ?? 10_000, () => {
            if (session.socket !== socket) return
            session.failureCause = 'health-check-failed'
            session.baseline = undefined
            socket.on('error', () => {})
            socket.terminate()
          })
        }
        signal.throwIfAborted()
        if (session.stale && session.failureCause !== 'credential-rotated') throw new SocketInterrupted({cause: 'remote-closed'})
        const full = fullBody(request.body)
        const signature = fingerprint(semanticSettings(full))
        const items = Array.isArray(full.input) ? full.input : []
        const hashes = items.map(fingerprint)
        const previous = session.baseline
        let decision = decide(cold, previous, request.confirmedResponseIds, signature, hashes)
        let body = decision.mode === 'ws-incremental' && previous
          ? {...full, previous_response_id: previous.responseId, input: items.slice(previous.items.length)} : full
        session.baseline = undefined
        for (let attempt = 0; attempt < 2; attempt++) {
          if (budget.sendsUsed >= budget.maxSends) throw new SocketInterrupted({cause: 'send-failed'})
          let restart = false
          attemptEvents = 0
          lastEventType = undefined
          lastEventSequence = undefined
          budget.sendsUsed++
          budget.attempt++
          notifyDecision(request, {...decision, connection: this.pool.connection(session)})
          notifyRequestBody(request, body)
          notifyTiming(request, 'request-sent')
          for await (const event of socketEvents(session.socket!, body, signal, this.options.timeoutMs ?? 300_000)) {
            if (attemptEvents === 0) notifyTiming(request, 'first-event')
            attemptEvents++
            if (attemptEvents === 1) {
              this.consecutiveFailures = 0
              this.cooldownUntil = 0
              if (probing) { this.probing = false; probing = false }
            }
            this.pool.checkRotation(session)
            if (typeof event.type === 'string' && /^[a-zA-Z0-9._:-]{1,96}$/.test(event.type)) lastEventType = event.type
            lastEventSequence = typeof event.sequence_number === 'number' && Number.isSafeInteger(event.sequence_number) && event.sequence_number >= 0
              ? event.sequence_number : attemptEvents
            const code = failureCode(event)
            if (code === 'websocket_connection_limit_reached') {
              session.retireRequested = true
              session.failureCause = 'connection-limit'
              session.baseline = undefined
              if (!observed && budget.sendsUsed < budget.maxSends) {
                throw new SocketInterrupted({cause: 'connection-limit', lastEventType, lastEventSequence})
              }
              notifyDisconnect(request, {cause: 'connection-limit',
                ...(lastEventType === undefined ? {} : {lastEventType}),
                ...(lastEventSequence === undefined ? {} : {lastEventSequence})})
              yield event
              return
            }
            if (code === 'previous_response_not_found' && !observed && attempt === 0 && 'previous_response_id' in body &&
              budget.previousResponseRecoveriesUsed < budget.maxPreviousResponseRecoveries && budget.sendsUsed < budget.maxSends) {
              budget.previousResponseRecoveriesUsed++
              body = full
              decision = {mode: 'ws-full', reason: 'previous-response-missing'}
              restart = true
              break
            }
            const classification = classifyWireEvent(event)
            if (classification.category === 'failed') { yield event; return }
            observed ||= classification.emitsOutput
            if (classification.category === 'completed') { completed = true; this.remember(session, event, signature, hashes) }
            yield event
          }
          if (restart) continue
          if (!completed) throw new SocketInterrupted({cause: 'remote-closed', lastEventType, lastEventSequence})
          return
        }
      } catch (error) {
        if (probing) { this.probing = false; probing = false }
        signal.throwIfAborted()
        this.pool.checkRotation(session)
        const invalidated = session.stale && session.failureCause !== 'credential-rotated'
        if (error instanceof SocketInterrupted) {
          if (handshakeSucceeded && attemptEvents === 0 && !invalidated) this.recordCooldownFailure()
          const fallbackCause = session.socket ? 'remote-closed' : 'handshake-failed'
          const specialCause = session.failureCause === 'health-check-failed' || session.failureCause === 'connection-limit'
            ? session.failureCause : undefined
          const cause = specialCause ?? error.disconnect?.cause ?? (session.failureCause === 'socket-error' ? 'socket-error' : fallbackCause)
          const closeCode = error.disconnect?.closeCode ?? session.closeCode
          const eventType = error.disconnect?.lastEventType ?? lastEventType
          const eventSequence = error.disconnect?.lastEventSequence ?? lastEventSequence
          session.failureCause = cause
          if (closeCode !== undefined) session.closeCode = closeCode
          notifyDisconnect(request, {cause, ...(closeCode === undefined ? {} : {closeCode}),
            ...(eventType === undefined ? {} : {lastEventType: eventType}),
            ...(eventSequence === undefined ? {} : {lastEventSequence: eventSequence})})
        }
        if (observed || !(error instanceof SocketInterrupted) || invalidated || budget.sendsUsed >= budget.maxSends) throw error
        // No content or tools have reached DSH, so HTTP can safely send the full input.
        session.cleanupSocket?.()
        session.cleanupSocket = undefined
        session.socket?.terminate()
        session.socket = undefined
        session.baseline = undefined
        const reason = session.failureCause === 'connection-limit' ? 'connection-limit' : 'socket-fallback'
        yield* this.streamHttp(request, session, headers, signal, budget, reason)
      }
    } finally {
      if (probing) this.probing = false
      this.pool.release(session, completed && !signal.aborted, signal.aborted ? 'cancelled' : 'request-failed')
    }
  }
  private async *streamHttp(
    request: TransportRequest, session: Session, headers: Record<string, string>,
    signal: AbortSignal, budget: AttemptBudget, reason: 'socket-fallback' | 'ws-cooldown' | 'connection-limit',
  ): AsyncGenerator<WireEvent> {
    if (budget.sendsUsed >= budget.maxSends) throw new SocketInterrupted({cause: 'send-failed'})
    const body = {...fullBody(request.body), stream: true, store: false}
    budget.sendsUsed++
    budget.attempt++
    notifyDecision(request, {mode: 'http-fallback', reason, connection: this.pool.connection(session)})
    notifyRequestBody(request, body)
    notifyTiming(request, 'request-sent')
    const response = await this.options.http(body, headers, signal, request.connectionId, budget)
    await checkResponse(response)
    let firstEvent = true
    for await (const event of readResponseEvents(response, signal)) {
      if (firstEvent) { firstEvent = false; notifyTiming(request, 'first-event') }
      yield event
    }
  }
  private remember(session: Session, event: WireEvent, settings: string, input: string[]): void {
    const response = event.response as WireEvent | undefined
    if (response?.status !== 'completed' || typeof response.id !== 'string' || !Array.isArray(response.output)) return
    session.baseline = {responseId: response.id, settings, items: [...input, ...response.output.map(fingerprint)]}
  }
}
