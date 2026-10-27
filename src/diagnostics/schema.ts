import { z } from 'zod'
import type { DiagnosticsFilter, DiagnosticsSnapshot, RequestDiagnostic } from './types.js'

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const boundedId = z.string().min(1).max(64)
export const requestCategorySchema = z.enum(['conversation', 'subagent', 'compaction', 'session-title', 'independent', 'connection-test'])
export const diagnosticReasonSchema = z.enum([
  'cold-connection', 'no-baseline', 'unconfirmed-response', 'settings-changed',
  'prefix-changed', 'continued', 'previous-response-missing', 'socket-fallback',
  'independent-call', 'websocket-disabled', 'not-started',
  'ws-cooldown', 'planned-rotation', 'connection-limit', 'health-check-failed',
])
export const replayReasonSchema = z.enum([
  'intact', 'edited', 'compacted', 'reordered', 'scope-changed', 'model-changed', 'missing-metadata',
])
export const diagnosticsFilterSchema: z.ZodType<DiagnosticsFilter> = z.strictObject({
  category: z.union([requestCategorySchema, z.literal('all')]).optional(),
  model: z.string().min(1).max(512).optional(),
  reason: z.union([diagnosticReasonSchema, z.literal('all')]).optional(),
})
export const cacheDiagnosticStatusSchema = z.enum([
  'cache_hit', 'cache_miss', 'comparison_response_not_found', 'unavailable',
])
export const cacheDiagnosticReasonSchema = z.enum([
  'model', 'service_tier', 'tools', 'reasoning_effort', 'format', 'response_format',
  'verbosity', 'compaction', 'prefix_mismatch', 'ttl_expired', 'cache_evicted', 'unknown',
])

export const diagnosticRecordSchema: z.ZodType<RequestDiagnostic> = z.object({
  id: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/), startedAt: count, durationMs: count,
  runtimeId: z.string().uuid().optional(),
  keyId: boundedId.optional(),
  attemptId: boundedId.optional(),
  baselineRequestId: boundedId.optional(),
  routing: z.object({wireSessionHash: hash, connectionHash: hash, previousGapMs: count.optional(),
    accountChanged: z.boolean().optional(), connectionChanged: z.boolean().optional(), modelChanged: z.boolean().optional(),
    wireSessionChanged: z.boolean().optional()}).optional(),
  durability: z.object({reason: z.enum(['no-candidate', 'session-missing', 'flush-failed', 'history-mismatch', 'confirmed', 'error']),
    candidates: count, confirmed: count}).optional(),
  metering: z.object({usage: z.enum(['missing', 'invalid', 'reported']), cache: z.enum(['missing', 'invalid', 'zero', 'positive']),
    reportedInputTokens: count.optional(), reportedCachedTokens: count.optional(), reportedOutputTokens: count.optional(),
    reportedCacheWriteTokens: count.optional()}).optional(),
  server: z.object({
    responseIdHash: hash.optional(),
    model: z.string().regex(/^[a-zA-Z0-9._:-]{1,128}$/).optional(),
    status: z.enum(['completed', 'failed', 'incomplete', 'cancelled', 'in_progress']).optional(),
    failure: z.enum(['rate-limit', 'authentication', 'context-limit', 'previous-response', 'other']).optional(),
    reasoningEffort: z.string().regex(/^[a-zA-Z0-9._:-]{1,64}$/).optional(),
    cacheDiagnostics: z.object({
      status: cacheDiagnosticStatusSchema,
      reason: cacheDiagnosticReasonSchema.optional(),
      reasons: z.array(cacheDiagnosticReasonSchema).max(16).optional(),
      reusableTokens: count.optional(),
      lostTokens: count.optional(),
    }).optional(),
  }).optional(),
  disconnect: z.object({
    cause: z.enum(['handshake-failed', 'remote-closed', 'socket-error', 'timeout', 'send-failed', 'health-check-failed', 'connection-limit']),
    closeCode: count.max(65535).optional(),
    lastEventType: z.string().regex(/^[a-zA-Z0-9._:-]{1,96}$/).optional(),
    lastEventSequence: count.optional(),
  }).optional(),
  request: z.object({
    inputItems: count, toolCount: count, cacheKeyPresent: z.boolean(),
    cacheRetention: z.enum(['in_memory', '24h']).optional(),
    cacheTtl: z.enum(['30m', '12h']).optional(),
    cacheMode: z.literal('implicit').optional(),
    comparisonIdPresent: z.boolean().optional(),
  }).optional(),
  timings: z.object({
    prepareStartedAt: count.optional(),
    requestReadyAt: count.optional(),
    handshakeStartedAt: count.optional(),
    handshakeCompletedAt: count.optional(),
    requestSentAt: count.optional(),
    firstServerEventAt: count.optional(),
    firstContentAt: count.optional(),
    firstTextAt: count.optional(),
    terminalAt: count.optional(),
    firstContentMs: count.optional(),
    firstTextMs: count.optional(),
  }).optional(),
  replay: z.object({
    totalBlocks: count,
    nativeBlocks: count,
    degradedBlocks: count,
    reasons: z.array(replayReasonSchema).max(16).optional(),
  }).optional(),
  accountKey: hash, sessionKey: hash.optional(), model: z.string().min(1).max(512), category: requestCategorySchema,
  outcome: z.enum(['completed', 'failed', 'cancelled']),
  sent: z.boolean().optional(),
  inputTokens: count.optional(), cachedTokens: count.optional(), cacheWriteTokens: count.optional(),
  cacheWriteIncomplete: z.boolean().optional(), outputTokens: count.optional(),
  transport: z.array(z.object({
    mode: z.enum(['ws-full', 'ws-incremental', 'http-fallback', 'http', 'not-started']),
    reason: diagnosticReasonSchema, firstDifference: count.optional(), attempt: count.optional(),
    connection: z.object({
      state: z.enum(['new', 'reused']),
      cause: z.enum([
        'first-use', 'idle-expired', 'capacity-evicted', 'credential-rotated', 'invalidated', 'cancelled',
        'remote-closed', 'socket-error', 'timeout', 'send-failed', 'handshake-failed', 'request-failed',
        'concurrent-call', 'duplicate-idle', 'unknown', 'planned-rotation', 'connection-limit', 'health-check-failed',
      ]),
      idleMs: count.optional(), ageMs: count.optional(), closeCode: count.max(65535).optional(), socketGeneration: count.optional(),
    }).optional(),
  })).max(8),
  prefixSkipped: z.literal('budget-exceeded').optional(),
  prefix: z.object({
    instructionsHash: hash, toolsHash: hash, settingsHash: hash, policyHash: hash.optional(), inputHash: hash,
    developerHashes: z.array(hash).max(64).optional(),
    systemPromptSource: z.enum(['system-field', 'leading-message', 'in-history', 'none']).optional(),
    expectedOutputMatched: z.boolean().optional(),
    itemCount: count, previousItemCount: count.optional(), sharedItems: count.optional(), firstDifference: count.optional(),
    change: z.enum(['first', 'unchanged', 'append', 'changed']),
    instructionsChanged: z.boolean().optional(), toolsChanged: z.boolean().optional(), settingsChanged: z.boolean().optional(),
  }).optional(),
}).refine(value => value.inputTokens === undefined || (
  (value.cachedTokens === undefined || value.cachedTokens <= value.inputTokens) &&
  (value.cacheWriteTokens === undefined || (value.cachedTokens ?? 0) + value.cacheWriteTokens <= value.inputTokens)
))

export const diagnosticSnapshotSchema: z.ZodType<DiagnosticsSnapshot> = z.object({
  retained: count.max(2000), limit: z.literal(2000), since: count.optional(), storageError: z.string().max(256).optional(),
  groups: z.array(z.object({category: requestCategorySchema, requests: count, measuredRequests: count, failed: count,
    inputTokens: count, cachedTokens: count, cacheWriteTokens: count.optional(), outputTokens: count, durationMs: count})).max(6),
  reasons: z.array(z.object({reason: diagnosticReasonSchema, requests: count})).max(15),
  recent: z.array(diagnosticRecordSchema).max(2000),
  records: z.array(diagnosticRecordSchema).max(2000).optional(),
  models: z.array(z.string().min(1).max(512)).max(2000).optional(),
  metrics: z.object({
    cacheReadRate: z.number().min(0).max(1).optional(),
    meteringCoverageRate: z.number().min(0).max(1).optional(),
    totalInputTokens: count, cachedTokens: count, cacheWriteTokens: count.optional(),
    otherInputTokens: count.optional(), missingCacheSamples: count,
  }).optional(),
})
