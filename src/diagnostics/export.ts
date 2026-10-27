import { diagnosticSnapshotSchema } from './schema.js'
import type { DiagnosticGroup, DiagnosticsFilter, DiagnosticsSnapshot, RequestDiagnostic, UnifiedDiagnosticMetrics } from './types.js'
export type { UnifiedDiagnosticMetrics } from './types.js'

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isSentRequest(record: RequestDiagnostic): boolean {
  if (record.sent !== undefined) return record.sent
  return !(record.transport.length > 0 && record.transport.every(item => item.mode === 'not-started'))
}

function hasActiveFilter(filter?: DiagnosticsFilter): boolean {
  if (!filter) return false
  return Boolean(
    (filter.category && filter.category !== 'all') ||
    (filter.model && filter.model !== 'all') ||
    (filter.reason && filter.reason !== 'all'),
  )
}

export function filterDiagnosticsRecords(records: readonly RequestDiagnostic[], filter?: DiagnosticsFilter): RequestDiagnostic[] {
  if (!hasActiveFilter(filter)) return [...records]
  return records.filter(record =>
    (!filter?.category || filter.category === 'all' || record.category === filter.category) &&
    (!filter?.model || filter.model === 'all' || record.model === filter.model) &&
    (!filter?.reason || filter.reason === 'all' || record.transport.some(t => t.reason === filter.reason)),
  )
}

export function findReconnectBaseline(current: RequestDiagnostic, records: readonly RequestDiagnostic[]): RequestDiagnostic | undefined {
  if (current.baselineRequestId) {
    const exact = records.find(item => item.id === current.baselineRequestId && item.id !== current.id)
    if (exact) return exact
  }
  if (!current.sessionKey) return undefined
  let best: RequestDiagnostic | undefined
  for (const item of records) {
    if (item.id === current.id || item.sessionKey !== current.sessionKey || item.startedAt > current.startedAt) continue
    if (!best || item.startedAt > best.startedAt) best = item
  }
  return best
}

export function summarizeDiagnosticsRecords(records: readonly RequestDiagnostic[]): {
  groups: DiagnosticGroup[]
  reasons: {reason: string; requests: number}[]
  metrics: UnifiedDiagnosticMetrics
} {
  const groups = new Map<RequestDiagnostic['category'], DiagnosticGroup>()
  const writes = new Map<RequestDiagnostic['category'], {sent: number; measured: number; total: number}>()
  const reasons = new Map<string, number>()
  for (const record of records) {
    const group = groups.get(record.category) ?? {
      category: record.category, requests: 0, measuredRequests: 0,
      failed: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, durationMs: 0,
    }
    group.requests++
    group.failed += Number(record.outcome !== 'completed')
    group.durationMs += record.durationMs
    group.outputTokens += record.outputTokens ?? 0
    if (record.inputTokens !== undefined && record.cachedTokens !== undefined) {
      group.measuredRequests++
      group.inputTokens += record.inputTokens
      group.cachedTokens += record.cachedTokens
    }
    groups.set(record.category, group)
    if (isSentRequest(record)) {
      const aggregate = writes.get(record.category) ?? {sent: 0, measured: 0, total: 0}
      aggregate.sent++
      const write = recordCacheWriteTokens(record)
      if (recordOtherInputTokens(record) !== undefined && write !== undefined) {
        aggregate.measured++
        aggregate.total += write
      }
      writes.set(record.category, aggregate)
    }
    for (const reason of new Set(record.transport.map(decision => decision.reason))) {
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
    }
  }
  for (const [category, aggregate] of writes) {
    if (aggregate.sent === aggregate.measured) groups.get(category)!.cacheWriteTokens = aggregate.total
  }
  return {
    groups: [...groups.values()],
    reasons: [...reasons].map(([reason, requests]) => ({reason, requests})),
    metrics: unifiedMetrics(records),
  }
}

export const summarizeFilteredDiagnostics = summarizeDiagnosticsRecords

export function recordCacheWriteTokens(record: RequestDiagnostic): number | undefined {
  if (record.cacheWriteIncomplete) return undefined
  return record.cacheWriteTokens ?? record.metering?.reportedCacheWriteTokens
}

export function recordOtherInputTokens(record: RequestDiagnostic): number | undefined {
  if (record.metering && (record.metering.usage !== 'reported' || (record.metering.cache !== 'zero' && record.metering.cache !== 'positive'))) {
    return undefined
  }
  const input = record.inputTokens ?? record.metering?.reportedInputTokens
  const cached = record.cachedTokens ?? record.metering?.reportedCachedTokens
  const write = recordCacheWriteTokens(record)
  if (!isNonNegativeInt(input) || !isNonNegativeInt(cached) || !isNonNegativeInt(write)) return undefined
  if (cached + write > input) return undefined
  return input - cached - write
}

export function unifiedMetrics(records: readonly RequestDiagnostic[]): UnifiedDiagnosticMetrics {
  let sentRequests = 0
  let measuredRequests = 0
  let totalInputTokens = 0
  let cachedTokens = 0
  let cacheWriteTokens = 0
  let otherSum = 0
  let completeThreeCount = 0
  let missingCacheSamples = 0

  for (const record of records) {
    const sent = isSentRequest(record)
    if (!sent) continue
    sentRequests++
    const meteringValid = !record.metering || (
      record.metering.usage === 'reported' && (record.metering.cache === 'zero' || record.metering.cache === 'positive')
    )
    const input = record.inputTokens ?? record.metering?.reportedInputTokens
    const cached = record.cachedTokens ?? record.metering?.reportedCachedTokens
    const write = recordCacheWriteTokens(record)

    if (meteringValid && isNonNegativeInt(input) && isNonNegativeInt(cached) && cached <= input) {
      measuredRequests++
      totalInputTokens += input
      cachedTokens += cached
      if (isNonNegativeInt(write) && cached + write <= input) {
        cacheWriteTokens += write
        otherSum += input - cached - write
        completeThreeCount++
      }
    } else if (sent) {
      missingCacheSamples++
    }
  }

  return {
    ...(totalInputTokens > 0 ? {cacheReadRate: cachedTokens / totalInputTokens} : {}),
    ...(sentRequests > 0 ? {meteringCoverageRate: measuredRequests / sentRequests} : {}),
    totalInputTokens,
    cachedTokens,
    ...(sentRequests > 0 && completeThreeCount === sentRequests ? {cacheWriteTokens} : {}),
    ...(sentRequests > 0 && completeThreeCount === sentRequests ? {otherInputTokens: otherSum} : {}),
    missingCacheSamples,
  }
}

function projectSnapshot(snapshot: DiagnosticsSnapshot, filter?: DiagnosticsFilter): DiagnosticsSnapshot & {
  records: RequestDiagnostic[]; metrics: UnifiedDiagnosticMetrics
} {
  const safe = diagnosticSnapshotSchema.parse(snapshot)
  const records = filterDiagnosticsRecords(safe.records ?? safe.recent, filter)
    .sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id))
  const summary = summarizeDiagnosticsRecords(records)
  const since = records.length ? Math.min(...records.map(r => r.startedAt)) : undefined
  return {
    retained: records.length,
    limit: safe.limit,
    ...(since !== undefined ? {since} : {}),
    ...(safe.storageError ? {storageError: safe.storageError} : {}),
    groups: summary.groups,
    reasons: summary.reasons,
    recent: records.slice(0, 30),
    records,
    metrics: summary.metrics,
    models: [...new Set(records.map(record => record.model))].sort(),
  }
}

export function exportDiagnosticsJson(snapshot: DiagnosticsSnapshot, filter?: DiagnosticsFilter): string {
  const safe = projectSnapshot(snapshot, filter)
  const until = safe.records.length
    ? Math.max(...safe.records.map(record => record.startedAt + record.durationMs))
    : safe.since
  return JSON.stringify({
    schemaVersion: 1,
    timeRange: {
      ...(safe.since !== undefined ? {since: safe.since} : {}),
      ...(until !== undefined ? {until} : {}),
    },
    metrics: safe.metrics,
    snapshot: safe,
  }, null, 2)
}

function csvCell(value: string | number | undefined): string {
  if (value === undefined) return ''
  const text = String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function exportDiagnosticsCsv(snapshot: DiagnosticsSnapshot, filter?: DiagnosticsFilter): string {
  const safe = projectSnapshot(snapshot, filter)
  const headers = [
    'schemaVersion', 'id', 'startedAt', 'category', 'model', 'outcome', 'durationMs',
    'inputTokens', 'cachedTokens', 'cacheWriteTokens', 'otherInputTokens', 'outputTokens',
    'transportMode', 'transportReason', 'cacheDiagnosticStatus', 'cacheDiagnosticReason',
    'firstContentMs', 'firstTextMs', 'replayNativeBlocks', 'replayTotalBlocks', 'sent',
  ]
  const rows = [headers.join(',')]
  for (const record of safe.records) {
    const lastTransport = record.transport.at(-1)
    const other = recordOtherInputTokens(record)
    const row = [
      1,
      record.id,
      record.startedAt,
      record.category,
      record.model,
      record.outcome,
      record.durationMs,
      record.inputTokens,
      record.cachedTokens,
      recordCacheWriteTokens(record),
      other,
      record.outputTokens,
      lastTransport?.mode,
      lastTransport?.reason,
      record.server?.cacheDiagnostics?.status,
      record.server?.cacheDiagnostics?.reason,
      record.timings?.firstContentMs,
      record.timings?.firstTextMs,
      record.replay?.nativeBlocks,
      record.replay?.totalBlocks,
      String(isSentRequest(record)),
    ].map(csvCell)
    rows.push(row.join(','))
  }
  return rows.join('\n')
}
