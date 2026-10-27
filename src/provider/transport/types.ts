import type WebSocket from 'ws'

export type WireEvent = Record<string, unknown>
export type SocketFactory = (headers: Record<string, string>, signal?: AbortSignal) => Promise<WebSocket>
export type SessionKind = 'conversation' | 'subagent' | 'other'
export type DisconnectCause = 'handshake-failed' | 'remote-closed' | 'socket-error' | 'timeout' | 'send-failed' |
  'health-check-failed' | 'connection-limit'
export type ConnectionCause = 'first-use' | 'idle-expired' | 'capacity-evicted' | 'duplicate-idle' | 'credential-rotated' |
  'invalidated' | 'cancelled' | 'remote-closed' | 'socket-error' | 'timeout' | 'send-failed' | 'handshake-failed' |
  'request-failed' | 'concurrent-call' | 'planned-rotation' | 'connection-limit' | 'health-check-failed' | 'unknown'
export interface DisconnectDiagnostic {
  cause: DisconnectCause
  closeCode?: number
  lastEventType?: string
  lastEventSequence?: number
}
export interface ConnectionDiagnostic {
  state: 'new' | 'reused'
  cause: ConnectionCause
  idleMs?: number
  ageMs?: number
  closeCode?: number
  socketGeneration?: number
}
export interface TransportDecision {
  mode: 'ws-full' | 'ws-incremental' | 'http-fallback' | 'http'
  reason: 'cold-connection' | 'no-baseline' | 'unconfirmed-response' | 'settings-changed' |
    'prefix-changed' | 'continued' | 'previous-response-missing' | 'socket-fallback' |
    'ws-cooldown' | 'planned-rotation' | 'connection-limit' | 'health-check-failed'
  firstDifference?: number
  connection?: ConnectionDiagnostic
  attempt?: number
}
export interface AttemptBudget {
  maxSends: number
  sendsUsed: number
  maxHandshakes: number
  handshakesUsed: number
  maxTokenRefreshes: number
  tokenRefreshesUsed: number
  maxPreviousResponseRecoveries: number
  previousResponseRecoveriesUsed: number
  attempt: number
}
export function createAttemptBudget(overrides?: Partial<AttemptBudget>): AttemptBudget {
  return {
    maxSends: 2,
    sendsUsed: 0,
    maxHandshakes: 2,
    handshakesUsed: 0,
    maxTokenRefreshes: 1,
    tokenRefreshesUsed: 0,
    maxPreviousResponseRecoveries: 1,
    previousResponseRecoveriesUsed: 0,
    attempt: 0,
    ...overrides,
  }
}
export interface TransportRequest {
  body: Record<string, unknown>
  sessionId: string
  connectionId: string
  accessToken: string
  credentialGeneration?: number
  sessionKind?: SessionKind
  signal?: AbortSignal
  confirmedResponseIds?: ReadonlySet<string>
  budget?: AttemptBudget
  onRequestBody?(body: Record<string, unknown>): void
  onDecision?(decision: TransportDecision): void
  onDisconnect?(disconnect: DisconnectDiagnostic): void
  onTiming?(stage: 'handshake-start' | 'handshake-end' | 'request-sent' | 'first-event', timestamp?: number): void
}
export interface TransportOptions {
  http(body: Record<string, unknown>, headers: Record<string, string>, signal: AbortSignal | undefined, connectionId: string, budget?: AttemptBudget): Promise<Response>
  socketFactory?: SocketFactory
  headers?: Record<string, string>
  /** Idle capacity override; the default retains up to 32 connections. */
  maxIdle?: number
  /** Optional idle expiry; by default invalidation and socket closure end reuse. */
  idleMs?: number
  timeoutMs?: number
  maxAgeMs?: number
  hardLimitMs?: number
  pingIntervalMs?: number
  pongTimeoutMs?: number
  probeIdleMs?: number
  cooldownBaseMs?: number
  cooldownMaxMs?: number
}
export interface Baseline { responseId: string; settings: string; items: string[] }
export interface Session {
  key: string
  group: string
  connectionId: string
  credential: string
  credentialGeneration?: number
  sessionKind: SessionKind
  useOrder: number
  socket?: WebSocket
  socketGeneration?: number
  baseline?: Baseline
  active: boolean
  stale: boolean
  retireRequested?: boolean
  needsProbe?: boolean
  networkEpoch?: number
  usedAt: number
  openedAt?: number
  openedMonotonicAt?: number
  lastPongAt?: number
  acquisition: ConnectionDiagnostic
  failureCause?: ConnectionCause
  closeCode?: number
  cleanupSocket?: () => void
}
