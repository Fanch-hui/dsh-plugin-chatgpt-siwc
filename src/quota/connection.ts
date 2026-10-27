import { createHash, randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { openCodexSignIn } from '../api/browser.js'
import { CodexRpc } from './rpc.js'
import { parseQuota } from './parse.js'
import type { QuotaSnapshot } from './types.js'

export interface QuotaView {
  state: 'ready' | 'unavailable'
  snapshot?: QuotaSnapshot
  error?: string
}
export interface CodexQuotaView {
  sourceKey?: string
  persistentLink?: boolean
  linkedToCurrent?: boolean
  state: 'disconnected' | 'connecting' | 'ready' | 'unavailable'
  email?: string
  planType?: string
  snapshot?: QuotaSnapshot
  error?: string
}
export interface QuotaRpc {
  request(method: string, params?: unknown): Promise<unknown>
  onNotification(listener: (method: string, params: unknown) => void): () => void
  onClose?(listener: () => void): () => void
  close(): Promise<void>
}
export interface QuotaDependencies {
  start?: (home: string) => Promise<QuotaRpc>
  browser?: (url: string) => Promise<void>
}
interface SourceCallbacks {
  clear(source: string): Promise<void>
  remember(source: string, persistent: boolean): Promise<void>
  available(source: string): boolean
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** One isolated Codex login and its account-scoped quota snapshot. */
export class QuotaConnection {
  private readonly nonce = randomUUID()
  private sourceKey?: string
  private persistent = false
  private view: CodexQuotaView = {state: 'disconnected'}
  private rpc?: QuotaRpc
  private starting?: Promise<QuotaRpc>
  private loginId?: string
  private earlyCompletion?: Record<string, unknown>
  private disposed = false
  private generation = 0
  private readonly reads = new Set<Promise<void>>()

  constructor(readonly id: string, private readonly home: string,
    private readonly dependencies: QuotaDependencies, private readonly sources: SourceCallbacks,
    knownSource?: string) {
    this.sourceKey = knownSource
    this.persistent = knownSource !== undefined
  }

  get revision(): number { return this.generation }
  status(): CodexQuotaView {
    return {...this.view, ...(this.sourceKey ? {sourceKey: this.sourceKey, persistentLink: this.persistent} : {})}
  }
  private async client(): Promise<QuotaRpc> {
    if (this.disposed) throw new Error('disposed')
    if (this.rpc) return this.rpc
    if (!this.starting) this.starting = (this.dependencies.start ?? CodexRpc.start)(this.home)
      .then(async rpc => {
        if (this.disposed) { await rpc.close(); throw new Error('disposed') }
        this.rpc = rpc
        rpc.onClose?.(() => {
          if (this.rpc !== rpc || this.disposed) return
          this.rpc = undefined
          this.loginId = undefined
          this.generation++
          if (this.view.state !== 'disconnected') {
            this.view = {...this.view, state: 'unavailable', error: 'Codex 额度连接已中断，请重新连接。'}
          }
        })
        rpc.onNotification((method, params) => {
          if (method !== 'account/login/completed' || this.view.state !== 'connecting') return
          const result = record(params)
          if (!this.loginId) { this.earlyCompletion = result; return }
          this.completeLogin(result)
        })
        return rpc
      }).finally(() => { this.starting = undefined })
    return this.starting
  }
  private completeLogin(result: Record<string, unknown>): void {
    if (result.loginId !== this.loginId || this.view.state !== 'connecting') return
    this.loginId = undefined
    if (result.success === true) void this.refresh(true)
    else this.view = {state: 'disconnected', error: 'Codex 登录未完成，请重试。'}
  }
  refresh(allowConnecting = false): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const reading = this.readQuota(allowConnecting)
    this.reads.add(reading)
    return reading.finally(() => { this.reads.delete(reading) })
  }
  private async readQuota(allowConnecting: boolean): Promise<void> {
    const generation = this.generation
    if (this.view.state === 'connecting' && !allowConnecting) return
    if (!this.rpc) {
      try { await access(join(this.home, 'auth.json')) }
      catch (error) {
        if (this.disposed || generation !== this.generation) return
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          await this.resetSource()
          if (!this.disposed && generation === this.generation) this.view = {state: 'disconnected'}
          return
        }
        this.view = {...this.view, state: 'unavailable', error: '无法读取 Codex 额度登录状态。'}
        return
      }
      if (this.disposed || generation !== this.generation) return
      try { await this.client() }
      catch {
        if (!this.disposed && generation === this.generation) {
          this.view = {...this.view, state: 'unavailable', error: '无法启动 Codex 额度查询，请检查 Codex CLI。'}
        }
        return
      }
    }
    if (this.loginId || this.disposed || generation !== this.generation || !this.rpc ||
      (this.view.state === 'connecting' && !allowConnecting)) return
    const rpc = this.rpc
    const previous = this.view
    const previousSource = this.sourceKey
    try {
      const account = record(record(await rpc.request('account/read', {refreshToken: false})).account)
      if (this.disposed || generation !== this.generation) return
      if (account.type !== 'chatgpt') {
        await this.resetSource()
        if (!this.disposed && generation === this.generation) this.view = {state: 'disconnected'}
        return
      }
      const limits = await rpc.request('account/rateLimits/read')
      if (this.disposed || generation !== this.generation) return
      const snapshot = parseQuota(limits)
      const id = record(limits).accountId
      const persistent = typeof id === 'string' && id.length > 0 && id.length <= 512
      if (!persistent && this.persistent && this.sourceKey) {
        this.view = {...previous, state: 'unavailable', error: '额度服务未提供账号标识，请刷新后重试。'}
        return
      }
      const source = createHash('sha256').update(JSON.stringify(persistent ? ['codex', id]
        : ['runtime', this.nonce, account.email ?? null, account.planType ?? null])).digest('hex')
      if (this.sourceKey && this.sourceKey !== source) await this.resetSource()
      if (this.disposed || generation !== this.generation) return
      if (!this.sources.available(source)) {
        this.view = {state: 'unavailable', error: '该额度账号已连接，请选择已有连接。'}
        return
      }
      this.sourceKey = source
      this.persistent = persistent
      this.view = {state: 'unavailable'}
      try { await this.sources.remember(source, persistent) }
      catch (error) {
        if (this.disposed || generation !== this.generation) return
        const retained = previousSource === source ? previous : {}
        if (previousSource !== source) { this.sourceKey = undefined; this.persistent = false }
        this.view = {...retained, state: 'unavailable',
          error: error instanceof Error && error.message.includes('已连接') ? error.message : '额度账号记录保存失败，请重试。'}
        return
      }
      if (this.disposed || generation !== this.generation) return
      this.view = {state: 'ready', snapshot,
        ...(typeof account.email === 'string' ? {email: account.email} : {}),
        ...(typeof account.planType === 'string' ? {planType: account.planType} : {})}
    } catch {
      if (this.disposed || generation !== this.generation) return
      if (this.rpc === rpc) { this.rpc = undefined; await rpc.close() }
      if (this.disposed || generation !== this.generation) return
      const retained = this.sourceKey === previousSource ? previous : {}
      this.view = {...retained, state: 'unavailable', error: 'Codex 额度读取失败，请检查连接后刷新。'}
    }
  }
  private async resetSource(): Promise<void> {
    const previous = this.sourceKey
    this.sourceKey = undefined
    this.persistent = false
    if (previous) await this.sources.clear(previous)
  }
  async connect(): Promise<void> {
    if (this.view.state === 'connecting') return
    const generation = ++this.generation
    this.earlyCompletion = undefined
    this.view = {state: 'connecting'}
    try {
      const rpc = await this.client()
      const existing = record(record(await rpc.request('account/read', {refreshToken: false})).account)
      if (this.disposed || generation !== this.generation) return
      if (existing.type === 'chatgpt') { await this.refresh(true); return }
      await this.resetSource()
      if (this.disposed || generation !== this.generation) return
      const login = record(await rpc.request('account/login/start', {type: 'chatgpt'}))
      if (typeof login.loginId !== 'string' || typeof login.authUrl !== 'string') throw new Error('invalid login')
      if (this.disposed || generation !== this.generation) {
        await rpc.request('account/login/cancel', {loginId: login.loginId})
        return
      }
      this.loginId = login.loginId
      if (this.earlyCompletion) {
        const result = this.earlyCompletion
        this.earlyCompletion = undefined
        this.completeLogin(result)
        if (!this.loginId) return
      }
      await (this.dependencies.browser ?? openCodexSignIn)(login.authUrl)
    } catch {
      if (!this.disposed && generation === this.generation) {
        await this.cancel()
        await this.rpc?.close()
        this.rpc = undefined
        this.view = {state: 'unavailable', error: '无法连接 Codex。请确认已安装 Codex，检查后重试。'}
      }
    }
  }
  async cancel(): Promise<void> {
    this.generation++
    this.earlyCompletion = undefined
    const id = this.loginId
    this.loginId = undefined
    this.view = {state: 'disconnected'}
    if (id && this.rpc) {
      try { await this.rpc.request('account/login/cancel', {loginId: id}) }
      catch { await this.rpc.close(); this.rpc = undefined }
    }
  }
  async disconnect(): Promise<boolean> {
    this.generation++
    await this.resetSource()
    await this.cancel()
    if (!this.rpc) {
      try { await access(join(this.home, 'auth.json')) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
        this.view = {state: 'unavailable', error: '无法读取 Codex 额度登录状态。'}
        return false
      }
    }
    try {
      const rpc = await this.client()
      await rpc.request('account/logout')
      this.view = {state: 'disconnected'}
      return true
    } catch { this.view = {state: 'unavailable', error: 'Codex 额度连接退出失败，请重试。'}; return false }
  }
  async dispose(): Promise<void> {
    this.disposed = true
    this.generation++
    await this.rpc?.close()
    await this.starting?.catch(() => {})
    await Promise.all(this.reads)
  }
}
