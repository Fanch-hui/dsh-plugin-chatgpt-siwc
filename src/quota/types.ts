export interface QuotaWindow {
  usedPercent: number
  windowDurationMins: number
  resetsAt?: number
}

export interface QuotaBucket {
  id: string
  name?: string
  model?: string
  planType?: string
  windows: QuotaWindow[]
  credits?: { unlimited: boolean; balance?: string }
}

export interface QuotaSnapshot {
  buckets: QuotaBucket[]
  updatedAt: number
}
