import { z } from 'zod'
import type { QuotaBucket, QuotaSnapshot, QuotaWindow } from './types.js'

const text = z.string().min(1).max(512)
const percent = z.number().finite().min(0).max(100)
const positive = z.number().finite().positive()
const timestamp = positive.int().max(Number.MAX_SAFE_INTEGER)
const credits = z.object({
  unlimited: z.boolean(),
  balance: z.string().max(128).refine(value => /^\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value))).nullish(),
})
const window = z.object({ usedPercent: percent, windowDurationMins: positive, resetsAt: timestamp.nullish() })
const bucket = z.object({
  limitId: text.nullish(), limitName: text.nullish(), normalModelSlug: text.nullish(), planType: text.nullish(),
  primary: window.nullish(), secondary: window.nullish(), credits: credits.nullish(),
}).refine(value => value.primary !== undefined || value.secondary !== undefined || value.credits !== undefined)
const response = z.object({
  rateLimits: bucket.nullish(), rateLimitsByLimitId: z.record(text, bucket).nullish(),
}).refine(value => value.rateLimits !== undefined || value.rateLimitsByLimitId !== undefined)
const invalid = () => new Error('额度服务返回的数据格式无效。')

function projectCredits(value: z.infer<typeof credits> | null | undefined): QuotaBucket['credits'] {
  if (!value) return undefined
  return { unlimited: value.unlimited, ...(value.balance !== undefined && value.balance !== null ? { balance: value.balance } : {}) }
}
function windows(value: z.infer<typeof bucket>): QuotaWindow[] {
  return [value.primary, value.secondary].flatMap(window => window ? [{
    usedPercent: window.usedPercent, windowDurationMins: window.windowDurationMins,
    ...(window.resetsAt != null ? { resetsAt: window.resetsAt } : {}),
  }] : [])
}

/** Only quota fields cross the Host boundary; service identity stays private. */
export function parseQuota(value: unknown): QuotaSnapshot {
  const parsed = response.safeParse(value)
  if (!parsed.success) throw invalid()
  const data = parsed.data
  const entries = data.rateLimitsByLimitId != null
    ? Object.entries(data.rateLimitsByLimitId)
    : data.rateLimits ? [[data.rateLimits.limitId ?? 'codex', data.rateLimits] as const] : []
  const buckets = entries.map(([id, bucket]) => {
    if (bucket.limitId != null && bucket.limitId !== id) throw invalid()
    const remainingCredits = projectCredits(bucket.credits)
    return { id, ...(bucket.normalModelSlug ? {model: bucket.normalModelSlug} : {}), ...(bucket.limitName ? { name: bucket.limitName } : {}),
      ...(bucket.planType ? { planType: bucket.planType } : {}), windows: windows(bucket),
      ...(remainingCredits ? { credits: remainingCredits } : {}) }
  })
  return {buckets, updatedAt: Date.now()}
}
