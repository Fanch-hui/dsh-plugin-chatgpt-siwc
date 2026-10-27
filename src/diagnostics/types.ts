import type { ConnectionCause, DisconnectCause } from '../provider/transport/types.js'
export type RequestCategory = 'conversation' | 'subagent' | 'compaction' | 'session-title' | 'independent' | 'connection-test'
export type DiagnosticConnectionCause = ConnectionCause | 'planned-rotation' | 'connection-limit' | 'health-check-failed'
export type DiagnosticDisconnectCause = DisconnectCause | 'health-check-failed' | 'connection-limit'
export type ReplayDegradeReason = 'intact' | 'edited' | 'compacted' | 'reordered' | 'scope-changed' | 'model-changed' | 'missing-metadata'
export type ServerCacheDiagnosticStatus = 'cache_hit' | 'cache_miss' | 'comparison_response_not_found' | 'unavailable'
export type ServerCacheDiagnosticReason = 'model' | 'service_tier' | 'tools' | 'reasoning_effort' | 'format' | 'response_format' | 'verbosity' | 'compaction' | 'prefix_mismatch' | 'ttl_expired' | 'cache_evicted' | 'unknown'
export type SystemPromptSource = 'system-field' | 'leading-message' | 'in-history' | 'none'

export interface DiagnosticsFilter {
  category?: RequestCategory | 'all'
  model?: string
  reason?: string
}

export interface RequestDiagnostic {
  id: string
  runtimeId?: string
  keyId?: string
  attemptId?: string
  baselineRequestId?: string
  routing?: {wireSessionHash: string; connectionHash: string; previousGapMs?: number; accountChanged?: boolean; connectionChanged?: boolean; modelChanged?: boolean; wireSessionChanged?: boolean}
  durability?: {reason: 'no-candidate' | 'session-missing' | 'flush-failed' | 'history-mismatch' | 'confirmed' | 'error'; candidates: number; confirmed: number}
  metering?: {usage: 'missing' | 'invalid' | 'reported'; cache: 'missing' | 'invalid' | 'zero' | 'positive'; reportedInputTokens?: number; reportedCachedTokens?: number; reportedOutputTokens?: number; reportedCacheWriteTokens?: number}
  server?: {
    responseIdHash?: string
    model?: string
    status?: 'completed' | 'failed' | 'incomplete' | 'cancelled' | 'in_progress'
    failure?: 'rate-limit' | 'authentication' | 'context-limit' | 'previous-response' | 'other'
    reasoningEffort?: string
    cacheDiagnostics?: {status: ServerCacheDiagnosticStatus; reason?: ServerCacheDiagnosticReason; reasons?: ServerCacheDiagnosticReason[]; reusableTokens?: number; lostTokens?: number}
  }
  disconnect?: {cause: DiagnosticDisconnectCause; closeCode?: number; lastEventType?: string; lastEventSequence?: number}
  request?: {inputItems: number; toolCount: number; cacheKeyPresent: boolean; cacheRetention?: 'in_memory' | '24h'; cacheTtl?: '30m' | '12h'; cacheMode?: 'implicit'; comparisonIdPresent?: boolean}
  timings?: {prepareStartedAt?: number; requestReadyAt?: number; handshakeStartedAt?: number; handshakeCompletedAt?: number; requestSentAt?: number; firstServerEventAt?: number; firstContentAt?: number; firstTextAt?: number; terminalAt?: number; firstContentMs?: number; firstTextMs?: number}
  replay?: {totalBlocks: number; nativeBlocks: number; degradedBlocks: number; reasons?: ReplayDegradeReason[]}
  startedAt: number
  durationMs: number
  accountKey: string
  sessionKey?: string
  model: string
  category: RequestCategory
  outcome: 'completed' | 'failed' | 'cancelled'
  sent?: boolean
  inputTokens?: number
  cachedTokens?: number
  cacheWriteTokens?: number
  cacheWriteIncomplete?: boolean
  outputTokens?: number
  transport: {
    mode: 'ws-full' | 'ws-incremental' | 'http-fallback' | 'http' | 'not-started'
    reason: string
    firstDifference?: number
    attempt?: number
    connection?: {state: 'new' | 'reused'; cause: DiagnosticConnectionCause; idleMs?: number; ageMs?: number; closeCode?: number; socketGeneration?: number}
  }[]
  prefixSkipped?: 'budget-exceeded'
  prefix?: {
    instructionsHash: string
    toolsHash: string
    settingsHash: string
    policyHash?: string
    inputHash: string
    developerHashes?: string[]
    systemPromptSource?: SystemPromptSource
    expectedOutputMatched?: boolean
    itemCount: number
    previousItemCount?: number
    sharedItems?: number
    firstDifference?: number
    change: 'first' | 'unchanged' | 'append' | 'changed'
    instructionsChanged?: boolean
    toolsChanged?: boolean
    settingsChanged?: boolean
  }
}
export interface DiagnosticGroup {
  category: RequestCategory
  requests: number
  measuredRequests: number
  failed: number
  inputTokens: number
  cachedTokens: number
  cacheWriteTokens?: number
  outputTokens: number
  durationMs: number
}
export interface DiagnosticsSnapshot {
  retained: number
  limit: number
  since?: number
  storageError?: string
  groups: DiagnosticGroup[]
  reasons: {reason: string; requests: number}[]
  recent: RequestDiagnostic[]
  records?: RequestDiagnostic[]
  models?: string[]
  metrics?: UnifiedDiagnosticMetrics
}

export interface UnifiedDiagnosticMetrics {
  cacheReadRate?: number
  meteringCoverageRate?: number
  totalInputTokens: number
  cachedTokens: number
  cacheWriteTokens?: number
  otherInputTokens?: number
  missingCacheSamples: number
}
