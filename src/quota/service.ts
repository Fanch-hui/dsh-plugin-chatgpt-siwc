import { createHash, randomUUID } from 'node:crypto'
import { QuotaLinks } from './links.js'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { ConnectionStore } from '../storage/state.js'
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
export interface QuotaStatus { codex: CodexQuotaView; current?: QuotaView & {source: 'linked-codex'} }
interface Rpc {
  request(method: string, params?: unknown): Promise<unknown>
  onNotification(listener: (method: string, params: unknown) => void): () => void
  onClose?(listener: () => void): () => void
  close(): Promise<void>
}
interface Dependencies {
  start?: (home: string) => Promise<Rpc>
  browser?: (url: string) => Promise<void>
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** Codex login is independent: email alone never binds its quota to a SIWC registration. */
export class QuotaService {
  private readonly links: QuotaLinks
  private readonly linkNonce = randomUUID()
  private sourceKey?: string
  private persistentLink = false
  private codex: CodexQuotaView = { state: 'disconnected' }
  private rpc?: Rpc
  private starting?: Promise<Rpc>
  private loginId?: string
  private earlyCompletion?: Record<string, unknown>
  private disposed = false
  private generation = 0
  private pending?: Promise<void>
  constructor(private readonly store: ConnectionStore, private readonly profileDir: string,
    private readonly dependencies: Dependencies = {}) { this.links = new QuotaLinks(profileDir) }

  status(accountId?: string): QuotaStatus {
    const linked = Boolean(accountId && this.sourceKey && this.links.matches(accountId, this.sourceKey))
    const codex = {...this.codex, linkedToCurrent: linked}
    if (!linked || !this.codex.snapshot) return {codex}
    const current: NonNullable<QuotaStatus['current']> = {source: 'linked-codex',
      state: this.codex.state === 'ready' ? 'ready' : 'unavailable', snapshot: this.codex.snapshot,
      ...(this.codex.error ? {error: this.codex.error} : {})}
    return {codex, current}
  }
  clear(accountId: string): Promise<void> { return this.links.unlink(accountId) }
  async refresh(): Promise<void> {
    if (this.disposed) return
    if (this.pending) return this.pending
    this.pending = this.links.load().then(() => this.refreshCodex())
      .finally(() => { this.pending = undefined })
    return this.pending
  }
  private async client(): Promise<Rpc> {
    if (this.disposed) throw new Error('disposed')
    if (this.rpc) return this.rpc
    if (!this.starting) this.starting = (this.dependencies.start ?? CodexRpc.start)(join(this.profileDir, 'chatgpt-siwc-codex-quota'))
      .then(async rpc => {
        if (this.disposed) { await rpc.close(); throw new Error('disposed') }
        this.rpc = rpc
        rpc.onClose?.(() => {
          if (this.rpc !== rpc || this.disposed) return
          this.rpc = undefined
          this.loginId = undefined
          this.generation++
          if (this.codex.state !== 'disconnected') {
            this.codex = {...this.codex, state: 'unavailable', error: 'Codex 额度连接已中断，请重新连接。'}
          }
        })
        rpc.onNotification((method, params) => {
          if (method !== 'account/login/completed' || this.codex.state !== 'connecting') return
          const result = record(params)
          if (!this.loginId) { this.earlyCompletion = result; return }
          this.completeLogin(result)
        })
        return rpc
      }).finally(() => { this.starting = undefined })
    return this.starting
  }
  private completeLogin(result: Record<string, unknown>): void {
    if (result.loginId !== this.loginId || this.codex.state !== 'connecting') return
    this.loginId = undefined
    if (result.success === true) void this.refreshCodex()
    else this.codex = {state: 'disconnected', error: 'Codex 登录未完成，请重试。'}
  }
  private async refreshCodex(): Promise<void> {
    if (!this.rpc) {
      try { await access(join(this.profileDir, 'chatgpt-siwc-codex-quota', 'auth.json')) }
      catch { return }
      try { await this.client() }
      catch { this.codex = {state: 'unavailable', error: '无法启动 Codex 额度查询，请检查 Codex CLI。'}; return }
    }
    if (this.loginId || this.disposed || !this.rpc) return
    const rpc = this.rpc
    const generation = this.generation
    const previous = this.codex
    const previousSource = this.sourceKey
    try {
      const account = record(record(await rpc.request('account/read', {refreshToken: false})).account)
      if (this.disposed || generation !== this.generation) return
      if (account.type !== 'chatgpt') {
        await this.resetSource()
        if (!this.disposed && generation === this.generation) this.codex = {state: 'disconnected'}
        return
      }
      if (previous.email && account.email !== previous.email) await this.resetSource()
      if (this.disposed || generation !== this.generation) return
      const limits = await rpc.request('account/rateLimits/read')
      const snapshot = parseQuota(limits)
      const id = record(limits).accountId
      const persistent = typeof id === 'string' && id.length > 0 && id.length <= 512
      const source = createHash('sha256').update(JSON.stringify(persistent ? ['codex', id]
        : ['runtime', this.linkNonce, account.email ?? null, account.planType ?? null])).digest('hex')
      await this.links.load()
      if (this.disposed || generation !== this.generation) return
      if (this.sourceKey && this.sourceKey !== source) await this.resetSource()
      if (this.disposed || generation !== this.generation) return
      this.sourceKey = source
      this.persistentLink = persistent
      this.codex = {state: 'ready', snapshot, sourceKey: source, persistentLink: persistent,
        ...(typeof account.email === 'string' ? {email: account.email} : {}),
        ...(typeof account.planType === 'string' ? {planType: account.planType} : {})}
    } catch {
      if (this.disposed || generation !== this.generation) return
      if (this.rpc === rpc) { this.rpc = undefined; await rpc.close() }
      if (this.disposed || generation !== this.generation) return
      const retained = this.sourceKey === previousSource ? previous : {}
      this.codex = {...retained, state: 'unavailable', error: 'Codex 额度读取失败，请检查连接后刷新。'}
    }
  }
  private async resetSource(): Promise<void> {
    this.sourceKey = undefined
    this.persistentLink = false
    await this.links.clear()
  }
  async connectCodex(): Promise<void> {
    if (this.codex.state === 'connecting') return
    const generation = ++this.generation
    this.earlyCompletion = undefined
    this.codex = {state: 'connecting'}
    try {
      const rpc = await this.client()
      const existing = record(record(await rpc.request('account/read', {refreshToken: false})).account)
      if (this.disposed || generation !== this.generation) return
      if (existing.type === 'chatgpt') { await this.refreshCodex(); return }
      if (this.disposed || generation !== this.generation) return
      await this.resetSource()
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
        await this.cancelCodex()
        await this.rpc?.close()
        this.rpc = undefined
        this.codex = {state: 'unavailable', error: '无法连接 Codex。请确认已安装 Codex，检查后重试。'}
      }
    }
  }
  async cancelCodex(): Promise<void> {
    this.generation++
    this.earlyCompletion = undefined
    const id = this.loginId
    this.loginId = undefined
    this.codex = {state: 'disconnected'}
    if (id && this.rpc) {
      try { await this.rpc.request('account/login/cancel', {loginId: id}) }
      catch { await this.rpc.close(); this.rpc = undefined }
    }
  }
  async disconnectCodex(): Promise<void> {
    await this.resetSource()
    await this.cancelCodex()
    try {
      const rpc = await this.client()
      await rpc.request('account/logout')
      this.codex = {state: 'disconnected'}
    } catch { this.codex = {state: 'unavailable', error: 'Codex 额度连接退出失败，请重试。'} }
  }
  async linkCodex(accountId: string, sourceKey: string): Promise<void> {
    const state = await this.store.read()
    if (state.accountId !== accountId || !state.credential) throw new Error('聊天账号已变化，请重新确认关联。')
    if (this.codex.state !== 'ready' || !this.codex.snapshot || this.sourceKey !== sourceKey) throw new Error('额度连接已变化，请刷新后重新确认。')
    const generation = this.generation
    await this.links.bind(accountId, sourceKey, this.persistentLink)
    const current = await this.store.read()
    if (this.disposed || generation !== this.generation || sourceKey !== this.sourceKey || current.accountId !== accountId || !current.credential) {
      await this.links.unlink(accountId)
      throw new Error('账号或额度连接已变化，请重新确认关联。')
    }
  }
  async unlinkCodex(accountId: string): Promise<void> { await this.links.unlink(accountId) }
  async dispose(): Promise<void> {
    this.disposed = true
    this.generation++
    await this.rpc?.close()
    await this.starting?.catch(() => {})
    await this.pending
  }
}
