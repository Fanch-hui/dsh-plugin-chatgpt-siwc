import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SiwcStatus, CacheSettings, ContextWindowSetting, QuotaLinkSetting } from '../api/types.js'
import type { DiagnosticsFilter, DiagnosticsSnapshot } from '../diagnostics/types.js'

export interface RemoteFace {
  queryDiagnostics(filter: DiagnosticsFilter): Promise<RemoteResult<DiagnosticsSnapshot>>
  setContextWindow(setting: ContextWindowSetting): Promise<RemoteResult<SiwcStatus>>
  setCacheSettings(settings: CacheSettings): Promise<RemoteResult<SiwcStatus>>
  status(): Promise<RemoteResult<SiwcStatus>>
  linkCodexQuota(setting: QuotaLinkSetting): Promise<RemoteResult<SiwcStatus>>
  unlinkCodexQuota(accountId: string): Promise<RemoteResult<SiwcStatus>>
  refreshQuota(): Promise<RemoteResult<SiwcStatus>>
  addCodexQuota(): Promise<RemoteResult<SiwcStatus>>
  selectCodexQuota(accountId: string): Promise<RemoteResult<SiwcStatus>>
  removeCodexQuota(accountId: string): Promise<RemoteResult<SiwcStatus>>
  connectCodexQuota(): Promise<RemoteResult<SiwcStatus>>
  cancelCodexQuota(): Promise<RemoteResult<SiwcStatus>>
  disconnectCodexQuota(): Promise<RemoteResult<SiwcStatus>>
  addAccount(): Promise<RemoteResult<SiwcStatus>>
  switchAccount(accountId: string): Promise<RemoteResult<SiwcStatus>>
  removeAccount(accountId: string): Promise<RemoteResult<SiwcStatus>>
  reauthorizeAccount(accountId: string): Promise<RemoteResult<SiwcStatus>>
  beginSignIn(): Promise<RemoteResult<SiwcStatus>>
  cancelSignIn(): Promise<RemoteResult<SiwcStatus>>
  signOut(): Promise<RemoteResult<SiwcStatus>>
  refreshModels(): Promise<RemoteResult<SiwcStatus>>
  probeModel(modelId: string): Promise<RemoteResult<SiwcStatus>>
  authorizeSession(sessionId: string): Promise<RemoteResult<SiwcStatus>>
  revokeSession(sessionId: string): Promise<RemoteResult<SiwcStatus>>
  setBackgroundAllowed(allowed: boolean): Promise<RemoteResult<SiwcStatus>>
}

export interface ClientSnapshot {
  status?: SiwcStatus
  pending?: string
  statusPending?: boolean
  quotaPending?: boolean
  modelsPending?: boolean
  quotaError?: string
  modelsError?: string
  error?: string
}

type ReadAction = 'status' | 'refreshQuota' | 'refreshModels'
type StatusAction = Exclude<keyof RemoteFace, 'queryDiagnostics'>
const pendingField = {status: 'statusPending', refreshQuota: 'quotaPending', refreshModels: 'modelsPending'} as const
const errorField = {status: 'error', refreshQuota: 'quotaError', refreshModels: 'modelsError'} as const

/** Settings and conversation controls consume one public Host snapshot. */
export class SiwcController {
  private snapshot: ClientSnapshot = {}
  private readonly listeners = new Set<() => void>()
  private timer?: ReturnType<typeof setTimeout>
  private disposed = false
  private quotaWatchers = 0
  private stopQuotaWatch?: () => void
  private quotaWatchKey?: string
  private quotaRequestedAt?: number
  private mutationGeneration = 0
  private modelsRevision = 0
  private quotaRevision = 0
  private readonly reads = new Map<ReadAction, Promise<void>>()

  constructor(private readonly remote: RemoteFace) {}

  getSnapshot = (): ClientSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  watchQuota(): () => void {
    if (this.disposed) return () => {}
    if (this.quotaWatchers++ === 0) this.startQuotaWatch()
    let released = false
    return () => {
      if (released || this.disposed) return
      released = true
      if (--this.quotaWatchers === 0) {
        this.stopQuotaWatch?.()
        this.stopQuotaWatch = undefined
      }
    }
  }

  async queryDiagnostics(filter: DiagnosticsFilter): Promise<DiagnosticsSnapshot> {
    const result = await this.remote.queryDiagnostics(filter)
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }

  async run(action: StatusAction, value?: string | boolean | ContextWindowSetting | QuotaLinkSetting | CacheSettings): Promise<void> {
    if (action === 'status' || action === 'refreshQuota' || action === 'refreshModels') return this.read(action)
    if (this.disposed || this.snapshot.pending) return
    this.mutationGeneration++
    clearTimeout(this.timer)
    this.update({...this.snapshot, pending: action, error: undefined})
    try {
      const result = await this.invoke(action, value)
      if (this.disposed) return
      if (result.ok) {
        this.modelsRevision++
        this.quotaRevision++
        this.update({...this.snapshot, status: result.value, pending: undefined})
      } else this.update({...this.snapshot, pending: undefined, error: result.error.message})
    } catch {
      if (!this.disposed) this.update({...this.snapshot, pending: undefined, error: '连接 DSH 服务失败，请重试。'})
    }
    this.schedulePoll()
  }

  private read(action: ReadAction): Promise<void> {
    const existing = this.reads.get(action)
    if (existing) return existing
    if (this.disposed || this.snapshot.pending) return Promise.resolve()
    const generation = this.mutationGeneration
    const revisions = {models: this.modelsRevision, quota: this.quotaRevision,
      quotaSource: this.snapshot.status && this.quotaWatchIdentity(this.snapshot.status)}
    const task = Promise.resolve().then(async () => {
      try {
        const result = await this.invoke(action)
        if (this.disposed || generation !== this.mutationGeneration) return
        if (result.ok) this.applyRead(action, result.value, revisions)
        else this.update({...this.snapshot, [errorField[action]]: result.error.message})
      } catch {
        if (!this.disposed && generation === this.mutationGeneration) {
          this.update({...this.snapshot, [errorField[action]]: '连接 DSH 服务失败，请重试。'})
        }
      } finally {
        this.reads.delete(action)
        if (!this.disposed) {
          this.update({...this.snapshot, [pendingField[action]]: false})
          this.schedulePoll()
        }
      }
    })
    this.reads.set(action, task)
    if (action === 'refreshQuota' && this.snapshot.status) {
      this.quotaWatchKey = this.quotaWatchIdentity(this.snapshot.status)
      this.quotaRequestedAt = Date.now()
    }
    this.update({...this.snapshot, [pendingField[action]]: true, [errorField[action]]: undefined})
    return task
  }

  private applyRead(action: ReadAction, result: SiwcStatus, revisions: {models: number; quota: number; quotaSource?: string}): void {
    let status = result
    const current = this.snapshot.status
    const sameAccount = current && this.quotaIdentity(current) === this.quotaIdentity(result)
    if (current && action !== 'status' && !sameAccount) return
    if (current && action === 'refreshQuota' && revisions.quotaSource !== undefined
      && this.quotaWatchIdentity(current) !== revisions.quotaSource) return
    if (current && action === 'refreshQuota') {
      status = {...current, quota: result.quota}
      this.quotaRevision++
    } else if (current && action === 'refreshModels') {
      status = {...current, models: result.models, availability: result.availability, error: result.error}
      this.modelsRevision++
    } else if (current && sameAccount) {
      if (this.quotaRevision !== revisions.quota) status = {...status, quota: current.quota}
      if (this.modelsRevision !== revisions.models) status = {...status, models: current.models, availability: current.availability, error: current.error}
    }
    this.update({...this.snapshot, status})
  }

  private schedulePoll(): void {
    clearTimeout(this.timer)
    if ((this.snapshot.status?.signingIn || quotaConnecting(this.snapshot.status)) && !this.disposed) {
      this.timer = setTimeout(() => { void this.run('status') }, 1_500)
    }
  }

  dispose(): void {
    this.disposed = true
    clearTimeout(this.timer)
    this.stopQuotaWatch?.()
    this.stopQuotaWatch = undefined
    this.quotaWatchers = 0
    this.listeners.clear()
  }

  private startQuotaWatch(): void {
    const refresh = () => {
      const {status, pending, quotaPending} = this.snapshot
      if (!status || pending || quotaPending || status.signingIn || status.quota?.codex.state === 'connecting') return
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      const sameSource = this.quotaWatchKey === this.quotaWatchIdentity(status)
      if (sameSource && this.quotaRequestedAt !== undefined && Date.now() - this.quotaRequestedAt < 60_000) return
      void this.run('refreshQuota')
    }
    const unsubscribe = this.subscribe(refresh)
    const interval = setInterval(refresh, 60_000)
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', refresh)
    if (typeof window !== 'undefined') window.addEventListener('focus', refresh)
    this.stopQuotaWatch = () => {
      unsubscribe()
      clearInterval(interval)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', refresh)
      if (typeof window !== 'undefined') window.removeEventListener('focus', refresh)
    }
    refresh()
  }

  private quotaIdentity(status: SiwcStatus): string {
    return `${status.activeAccountId ?? 'signed-out'}:${status.authenticated}`
  }

  private quotaWatchIdentity(status: SiwcStatus): string {
    return `${this.quotaIdentity(status)}:${status.quota?.selectedAccountId ?? ''}:${status.quota?.codex.sourceKey ?? ''}`
  }

  private invoke(action: StatusAction, value?: string | boolean | ContextWindowSetting | QuotaLinkSetting | CacheSettings): Promise<RemoteResult<SiwcStatus>> {
    if (action === 'setContextWindow') {
      if (!value || typeof value !== 'object' || !('contextWindow' in value)) throw new Error('上下文窗口设置格式错误。')
      return this.remote.setContextWindow(value)
    }
    if (action === 'setCacheSettings') {
      if (!value || typeof value !== 'object') throw new Error('缓存增强设置格式错误。')
      return this.remote.setCacheSettings(value as CacheSettings)
    }
    if (action === 'linkCodexQuota') {
      if (!value || typeof value !== 'object' || !('sourceKey' in value)) throw new Error('额度关联格式错误。')
      return this.remote.linkCodexQuota(value)
    }
    if (action === 'setBackgroundAllowed') return this.remote[action](value === true)
    if (action === 'probeModel' || action === 'authorizeSession' || action === 'revokeSession' || action === 'switchAccount' || action === 'removeAccount' || action === 'reauthorizeAccount' || action === 'unlinkCodexQuota' || action === 'selectCodexQuota' || action === 'removeCodexQuota') {
      return this.remote[action](String(value ?? ''))
    }
    return this.remote[action]()
  }

  private update(snapshot: ClientSnapshot): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}

function quotaConnecting(status: SiwcStatus | undefined): boolean {
  const quota = status?.quota
  return quota?.codex.state === 'connecting' || quota?.accounts?.some(account => account.state === 'connecting') === true
}
