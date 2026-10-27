import type { RequestDiagnostic, ServerCacheDiagnosticReason, ServerCacheDiagnosticStatus } from './types.js'

type RecordValue = Record<string, unknown>
const cacheReasonMap: Record<string, ServerCacheDiagnosticReason> = {
  model_changed: 'model', model: 'model',
  service_tier_changed: 'service_tier', service_tier: 'service_tier',
  tools_changed: 'tools', tools: 'tools',
  reasoning_effort_changed: 'reasoning_effort', reasoning_effort: 'reasoning_effort',
  response_format_changed: 'format', response_format: 'format', format: 'format',
  text_verbosity_changed: 'verbosity', verbosity: 'verbosity',
  compaction_changed: 'compaction', compaction: 'compaction',
  prefix_mismatch: 'prefix_mismatch',
  ttl_expired: 'ttl_expired',
  cache_evicted: 'cache_evicted',
}
function normalizeCacheReason(raw: string): ServerCacheDiagnosticReason {
  return cacheReasonMap[raw] ?? 'unknown'
}
const cacheStatuses = new Set<ServerCacheDiagnosticStatus>([
  'cache_hit', 'cache_miss', 'comparison_response_not_found', 'unavailable',
])
function object(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined
}
function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function requestMetadata(body: RecordValue): NonNullable<RequestDiagnostic['request']> {
  const result: NonNullable<RequestDiagnostic['request']> = {
    inputItems: Array.isArray(body.input) ? body.input.length : 0,
    toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
    cacheKeyPresent: typeof body.prompt_cache_key === 'string' && body.prompt_cache_key.length > 0,
  }
  if (body.prompt_cache_retention === 'in_memory' || body.prompt_cache_retention === '24h') result.cacheRetention = body.prompt_cache_retention
  const options = object(body.prompt_cache_options)
  if (options?.ttl === '30m' || options?.ttl === '12h') result.cacheTtl = options.ttl
  if (options?.mode === 'implicit') result.cacheMode = 'implicit'
  if (typeof options?.comparison_response_id === 'string' && options.comparison_response_id.length > 0) result.comparisonIdPresent = true
  return result
}

export function usageObservation(value: unknown): NonNullable<RequestDiagnostic['metering']> {
  const usage = object(value)
  if (value === undefined) return {usage: 'missing', cache: 'missing'}
  if (!usage) return {usage: 'invalid', cache: 'missing'}
  const details = object(usage.input_tokens_details)
  const cached = details?.cached_tokens
  const write = details?.cache_write_tokens
  const result: NonNullable<RequestDiagnostic['metering']> = {usage: 'reported', cache: 'missing'}
  if (usage.input_tokens_details != null && !details) result.cache = 'invalid'
  if (count(usage.input_tokens)) result.reportedInputTokens = usage.input_tokens
  if (count(usage.output_tokens)) result.reportedOutputTokens = usage.output_tokens
  if (cached !== undefined) {
    result.cache = 'invalid'
    if (count(cached)) {
      result.reportedCachedTokens = cached
      result.cache = cached === 0 ? 'zero' : 'positive'
    }
  }
  if (write !== undefined) {
    if (!count(write) || (count(cached) ? cached : 0) + write > (count(usage.input_tokens) ? usage.input_tokens : -1)) {
      result.usage = 'invalid'
      result.cache = 'invalid'
    } else {
      result.reportedCacheWriteTokens = write
    }
  }
  if (!count(usage.input_tokens) || !count(usage.output_tokens) || result.cache === 'invalid'
    || (count(cached) && count(usage.input_tokens) && cached > usage.input_tokens)) {
    result.usage = 'invalid'
    if (count(cached) && count(usage.input_tokens) && cached > usage.input_tokens) result.cache = 'invalid'
  }
  return result
}

function failureKind(code: unknown): NonNullable<RequestDiagnostic['server']>['failure'] {
  if (typeof code !== 'string') return 'other'
  if (['rate_limit_exceeded', 'usage_limit_reached', 'insufficient_quota'].includes(code)) return 'rate-limit'
  if (['invalid_api_key', 'invalid_token', 'token_expired', 'unauthorized', 'authentication_error'].includes(code)) return 'authentication'
  if (['context_length_exceeded', 'context_window_exceeded', 'max_tokens_exceeded'].includes(code)) return 'context-limit'
  if (code === 'previous_response_not_found') return 'previous-response'
  return 'other'
}

function parseCacheDiagnostics(raw: unknown): NonNullable<RequestDiagnostic['server']>['cacheDiagnostics'] {
  const diag = object(raw)
  const rawStatus = typeof diag?.type === 'string' ? diag.type : diag?.status
  if (!diag || typeof rawStatus !== 'string' || !cacheStatuses.has(rawStatus as ServerCacheDiagnosticStatus)) return undefined
  const result: NonNullable<NonNullable<RequestDiagnostic['server']>['cacheDiagnostics']> = {
    status: rawStatus as ServerCacheDiagnosticStatus,
  }
  const reasons = Array.isArray(diag.reasons)
    ? [...new Set(diag.reasons.filter((r): r is string => typeof r === 'string' && r.length > 0).map(normalizeCacheReason))].slice(0, 16)
    : undefined
  if (typeof diag.reason === 'string' && diag.reason.length > 0) {
    result.reason = normalizeCacheReason(diag.reason)
  } else if (reasons?.length) {
    result.reason = reasons[0]
  }
  if (reasons?.length) result.reasons = reasons
  const reusable = diag.comparison_reusable_tokens ?? diag.reusable_tokens ?? diag.reusableTokens
  if (count(reusable)) result.reusableTokens = reusable
  const lost = diag.cache_missed_tokens ?? diag.lost_tokens ?? diag.lostTokens
  if (count(lost)) result.lostTokens = lost
  return result
}

export function observeEvent(record: RequestDiagnostic, event: RecordValue, hash: (value: unknown) => string): void {
  if (!['response.completed', 'response.failed', 'response.incomplete', 'error'].includes(String(event.type))) return
  const response = object(event.response)
  const server: NonNullable<RequestDiagnostic['server']> = {...record.server}
  if (typeof response?.id === 'string' && response.id.length <= 512) server.responseIdHash = hash(['response', response.id])
  if (typeof response?.model === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(response.model)) server.model = response.model
  const status = response?.status
  if (status === 'completed' || status === 'failed' || status === 'incomplete' || status === 'cancelled' || status === 'in_progress') server.status = status
  const effort = object(response?.reasoning)?.effort
  if (typeof effort === 'string' && /^[a-zA-Z0-9._:-]{1,64}$/.test(effort)) server.reasoningEffort = effort
  const cacheDiag = parseCacheDiagnostics(response?.prompt_cache_diagnostics ?? event.prompt_cache_diagnostics)
  if (cacheDiag) server.cacheDiagnostics = cacheDiag
  if (event.type === 'error' || event.type === 'response.failed' || event.type === 'response.incomplete') {
    const error = object(event.error) ?? object(response?.error)
    const incomplete = object(response?.incomplete_details)
    server.failure = failureKind(error?.code ?? event.code ?? incomplete?.reason)
  }
  if (Object.keys(server).length) record.server = server
  if (event.type === 'response.completed' || (
    (event.type === 'response.failed' || event.type === 'response.incomplete') && response?.usage !== undefined
  )) {
    if (record.metering?.usage !== 'reported' || response?.usage !== undefined) {
      record.metering = usageObservation(response?.usage)
    }
  }
}
