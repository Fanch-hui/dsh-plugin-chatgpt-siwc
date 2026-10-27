import { ConnectionStore } from '../storage/state.js'
import { QuotaAccounts, quotaHome } from './accounts.js'
import { QuotaConnection } from './connection.js'
import type { CodexQuotaView, QuotaDependencies, QuotaView } from './connection.js'
import { QuotaLinks } from './links.js'

export type { CodexQuotaView, QuotaView } from './connection.js'
export interface CodexQuotaAccountView extends CodexQuotaView { id: string }
export interface QuotaStatus {
  codex: CodexQuotaView
  accounts?: CodexQuotaAccountView[]
  selectedAccountId?: string
  current?: QuotaView & {source: 'linked-codex'}
}

/** Manages isolated Codex quota logins and user-confirmed chat account associations. */
export class QuotaService {
  private readonly links: QuotaLinks
  private readonly accounts: QuotaAccounts
  private readonly connections = new Map<string, QuotaConnection>()
  private selectedId?: string
  private initialized?: Promise<void>
  private pending?: Promise<void>
  private accountQueue: Promise<void> = Promise.resolve()
  private disposed = false
  private closing?: Promise<void>

  constructor(private readonly store: ConnectionStore, private readonly profileDir: string,
    private readonly dependencies: QuotaDependencies = {}) {
    this.links = new QuotaLinks(profileDir)
    this.accounts = new QuotaAccounts(profileDir)
  }

  status(accountId?: string): QuotaStatus {
    const accounts = [...this.connections.values()].map(connection => {
      const view = connection.status()
      return {id: connection.id, ...view,
        linkedToCurrent: Boolean(accountId && view.sourceKey && this.links.matches(accountId, view.sourceKey))}
    })
    const selected = accounts.find(account => account.id === this.selectedId)
    const codex = selected ?? {state: 'disconnected' as const, linkedToCurrent: false}
    const linked = accounts.find(account => account.linkedToCurrent)
    const current = linked ? {
      source: 'linked-codex' as const,
      state: linked.state === 'ready' ? 'ready' as const : 'unavailable' as const,
      ...(linked.snapshot ? {snapshot: linked.snapshot} : {}),
      ...(linked.error ? {error: linked.error} : {}),
    } : undefined
    return {codex, accounts, ...(this.selectedId ? {selectedAccountId: this.selectedId} : {}),
      ...(current ? {current} : {})}
  }
  clear(accountId: string): Promise<void> { return this.links.unlink(accountId) }

  async refresh(): Promise<void> {
    if (this.disposed) return
    if (this.pending) return this.pending
    this.pending = (async () => {
      await this.initialize()
      await this.reconcile()
      await this.links.reload()
      await Promise.all([...this.connections.values()].map(connection => connection.refresh()))
    })().finally(() => { this.pending = undefined })
    return this.pending
  }
  private initialize(): Promise<void> {
    if (!this.initialized) {
      this.initialized = this.links.load().then(() => this.reconcile())
        .catch(error => { this.initialized = undefined; throw error })
    }
    return this.initialized
  }
  private serializeAccounts<T>(action: () => Promise<T>): Promise<T> {
    const next = this.accountQueue.then(action, action)
    this.accountQueue = next.then(() => {}, () => {})
    return next
  }
  private addConnection(id: string, knownSource?: string): QuotaConnection {
    const existing = this.connections.get(id)
    if (existing) return existing
    const connection: QuotaConnection = new QuotaConnection(id, quotaHome(this.profileDir, id), this.dependencies, {
      clear: async source => {
        await this.links.clearSource(source)
        await this.accounts.clearSource(id, source)
      },
      remember: (source, persistent) => this.accounts.setSource(id, persistent ? source : undefined),
      available: source => ![...this.connections.values()].some(other =>
        other !== connection && other.status().sourceKey === source),
    }, knownSource)
    this.connections.set(id, connection)
    return connection
  }
  private reconcile(): Promise<void> {
    return this.serializeAccounts(async () => {
      const accounts = await this.accounts.read()
      const ids = accounts.map(account => account.id)
      for (const account of accounts) {
        const legacySource = ids.length === 1 && account.id === 'legacy' ? this.links.singlePersistentSource() : undefined
        this.addConnection(account.id, account.sourceKey ?? legacySource)
      }
      for (const [id, connection] of this.connections) {
        if (ids.includes(id)) continue
        this.connections.delete(id)
        await connection.dispose()
      }
      if (!this.selectedId || !this.connections.has(this.selectedId)) this.selectedId = ids[0]
    })
  }
  private async selected(create = false): Promise<QuotaConnection> {
    await this.initialize()
    if (this.disposed) throw new Error('额度连接已关闭。')
    if (!this.selectedId && create) {
      await this.serializeAccounts(async () => {
        if (!this.selectedId) {
          this.selectedId = await this.accounts.add('legacy')
          this.addConnection(this.selectedId)
        }
      })
    }
    const connection = this.selectedId && this.connections.get(this.selectedId)
    if (!connection) throw new Error('请选择额度账号。')
    return connection
  }
  async connectCodex(): Promise<void> { await (await this.selected(true)).connect() }
  async addCodex(): Promise<void> {
    await this.initialize()
    if (this.disposed) throw new Error('额度连接已关闭。')
    const connection = await this.serializeAccounts(async () => {
      const id = await this.accounts.add()
      this.selectedId = id
      return this.addConnection(id)
    })
    await connection.connect()
  }
  async selectCodex(id: string): Promise<void> {
    await this.initialize()
    if (this.disposed || !this.connections.has(id)) throw new Error('额度账号不存在，请刷新后重试。')
    this.selectedId = id
  }
  async cancelCodex(): Promise<void> { await (await this.selected()).cancel() }
  async disconnectCodex(): Promise<void> { await (await this.selected()).disconnect() }
  async removeCodex(id: string): Promise<void> {
    await this.initialize()
    if (this.disposed) throw new Error('额度连接已关闭。')
    await this.serializeAccounts(async () => {
      const connection = this.connections.get(id)
      if (!connection) throw new Error('额度账号不存在，请刷新后重试。')
      if (!await connection.disconnect()) throw new Error('Codex 额度连接退出失败，请重试。')
      await this.accounts.remove(id)
      this.connections.delete(id)
      await connection.dispose()
      if (this.selectedId === id) this.selectedId = this.connections.keys().next().value
    })
  }
  async linkCodex(accountId: string, sourceKey: string): Promise<void> {
    const connection = await this.selected()
    const state = await this.store.read()
    if (state.accountId !== accountId || !state.credential) throw new Error('聊天账号已变化，请重新确认关联。')
    const view = connection.status()
    if (view.state !== 'ready' || !view.snapshot || view.sourceKey !== sourceKey) throw new Error('额度连接已变化，请刷新后重新确认。')
    const generation = connection.revision
    await this.links.bind(accountId, sourceKey, view.persistentLink === true)
    const current = await this.store.read()
    if (this.disposed || this.connections.get(connection.id) !== connection || this.selectedId !== connection.id ||
      generation !== connection.revision || sourceKey !== connection.status().sourceKey ||
      current.accountId !== accountId || !current.credential) {
      await this.links.unlinkMatching(accountId, sourceKey)
      throw new Error('账号或额度连接已变化，请重新确认关联。')
    }
  }
  async unlinkCodex(accountId: string): Promise<void> { await this.links.unlink(accountId) }
  dispose(): Promise<void> {
    return this.closing ??= this.close()
  }
  private async close(): Promise<void> {
    this.disposed = true
    await this.initialized?.catch(() => {})
    await this.accountQueue
    await Promise.all([...this.connections.values()].map(connection => connection.dispose()))
    await this.pending
  }
}
