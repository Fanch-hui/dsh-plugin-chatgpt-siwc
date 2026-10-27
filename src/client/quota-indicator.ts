import type { SiwcStatus } from '../api/types.js'

export interface QuotaIndicatorView {
  remaining?: number
  windows: {label: string; remaining: number; resetsAt?: number}[]
  credits?: string
  updatedAt?: number
  message?: string
  stale?: boolean
}

export function quotaIndicator(status: SiwcStatus, model?: string): QuotaIndicatorView {
  const current = status.quota?.current
  const snapshot = current?.snapshot
  if (!snapshot) return {windows: [], message: current
    ? (current.error ?? '额度暂不可用，请在插件设置中刷新。')
    : '请在插件设置中关联额度。'}
  const modelBucket = model ? snapshot.buckets.find(bucket => bucket.model === model || bucket.id === model) : undefined
  const shared = snapshot.buckets.find(bucket => bucket.id === 'codex')
  const only = snapshot.buckets.length === 1 && !snapshot.buckets[0].model ? snapshot.buckets[0] : undefined
  const bucket = modelBucket ?? shared ?? only
  if (!bucket) return {windows: [], message: '暂未提供当前模型的额度。', updatedAt: snapshot.updatedAt}
  const windows = bucket.windows.map(window => ({
    label: windowLabel(window.windowDurationMins),
    remaining: Math.round((100 - window.usedPercent) * 10) / 10,
    ...(window.resetsAt === undefined ? {} : {resetsAt: window.resetsAt}),
  }))
  const view: QuotaIndicatorView = {windows, updatedAt: snapshot.updatedAt}
  if (windows.length) view.remaining = Math.min(...windows.map(window => window.remaining))
  if (bucket.credits?.unlimited) view.credits = '积分不限量'
  else if (bucket.credits?.balance !== undefined) view.credits = `可用积分 ${bucket.credits.balance}`
  if (!windows.length && !view.credits) view.message = '暂未提供额度窗口。'
  if (current.state !== 'ready') view.stale = true
  return view
}

function windowLabel(minutes: number): string {
  if (minutes === 10080) return '每周'
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`
  if (minutes % 60 === 0) return `${minutes / 60} 小时`
  return `${minutes} 分钟`
}

export function formatQuotaTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  })
}
