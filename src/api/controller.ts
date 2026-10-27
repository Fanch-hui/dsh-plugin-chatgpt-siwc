import { RequestDiagnostics } from '../diagnostics/requests.js'
import type { DiagnosticsStore } from '../diagnostics/store.js'
import type { DiagnosticsFilter, DiagnosticsSnapshot } from '../diagnostics/types.js'
import type { QuotaService } from '../quota/service.js'
import { LlmError, type GenerateOptions, type TokenUsage } from '@deepseek-ai/dsh-llm'
import { AuthError, SiwcAuth, type SignInAttempt } from '../auth/index.js'
import { ChatGPTSiwcAdapter, type ProviderConnection, type ProviderDependencies } from '../provider/adapter.js'
import { CAPABILITY_PROJECTION_VERSION, CapabilityRegistry } from '../provider/capabilities.js'
import { ProviderError } from '../provider/errors.js'
import { resolveReplayScope } from '../provider/session.js'
import { ConnectionStore, connectionId, deriveReplayScope, type CacheSettings, type StoredState } from '../storage/state.js'
import { authorizeCall, type SessionLineage } from '../policy/authorize.js'
import { openSignIn } from './browser.js'
import type { SiwcRemote, SiwcStatus, ContextWindowSetting, QuotaLinkSetting } from './types.js'

export class Controller implements SiwcRemote {
  readonly adapter: ChatGPTSiwcAdapter
  private readonly capabilities = new CapabilityRegistry()
  private readonly requestDiagnostics?: RequestDiagnostics
  private diagnosticsSecretReady?: Promise<void>
  private readonly lifetime = new AbortController()
  private connectionLifetime = new AbortController()
  private attempt?: SignInAttempt
  private signingIn = false
  private error?: string
  private availability: SiwcStatus['availability'] = 'ready'
  private models: SiwcStatus['models'] = []
  private usageWrites: Promise<unknown> = Promise.resolve()
  private transition: Promise<unknown> = Promise.resolve()

  constructor(private readonly store: ConnectionStore,
    private readonly header: (id: string) => SessionLineage | undefined,
    image: ProviderDependencies['image'],
    private readonly auth = new SiwcAuth(),
    private readonly browser = openSignIn,
    imageAccess?: ProviderDependencies['imageAccess'],
    runtime: Pick<ProviderDependencies, 'sessionScope' | 'confirmedResponses' | 'websocket' | 'socketFactory'> = {},
    private readonly quota?: QuotaService,
    private readonly diagnostics?: DiagnosticsStore) {
    this.requestDiagnostics = diagnostics && new RequestDiagnostics(diagnostics, options => {
      if (options.purpose) return options.purpose
      if (!options.sessionId) return 'independent'
      return this.header(options.sessionId)?.origin === 'subagent' ? 'subagent' : 'conversation'
    }, {
      profileDir: diagnostics.profileDir,
      onSecretExpired: () => { this.diagnosticsSecretReady = this.rotateDiagnosticsSecret(false) },
    })
    if (this.requestDiagnostics) void this.ensureDiagnosticsSecret()
    this.adapter = new ChatGPTSiwcAdapter({
      diagnostics: this.requestDiagnostics,
      capabilities: this.capabilities,
      onCapability: async (model, capability, status, connection) => {
        if (connection.accountId) {
          await this.store.recordCapability(connection.accountId, connection.grantEpoch ?? 1, model, capability, status, CAPABILITY_PROJECTION_VERSION)
        }
      },
      enhancements: (options, connection) => {
        const settings = connection.cacheSettings
        if (!settings) return undefined
        const replayScope = resolveReplayScope(runtime.sessionScope ?? 'standalone', connection)
        const comparisonResponseId = settings.comparisonDiagnostics
          ? latestConfirmedResponseId(options.messages, replayScope, connection)
          : undefined
        const cacheOptions = settings.ttl || comparisonResponseId
          ? {
              ...(settings.ttl ? { mode: 'implicit' as const, ttl: settings.ttl } : {}),
              ...(comparisonResponseId ? { comparisonResponseId } : {}),
            }
          : undefined
        return {
          ...(cacheOptions ? { cacheOptions } : {}),
          ...(settings.configurationUpdate ? { configurationUpdate: true } : {}),
          ...(settings.toolAdditions ? { toolUpdate: 'addition-only' as const } : {}),
        }
      },
      sessionKind: options => {
        if (!options.sessionId || options.purpose) return 'other'
        const header = this.header(options.sessionId)
        if (!header) return 'other'
        return header.origin === 'subagent' ? 'subagent' : 'conversation'
      },
      connection: (signal, rejected) => this.connection(signal, rejected),
      authorize: (options, connection) => this.authorize(options, connection), image, imageAccess,
      onUsage: (usage, connection) => this.recordUsage(usage, connection),
      onError: (error, connection) => { if (!connection.signal?.aborted) this.capture(error) },
      contextWindow: async (connection, model) => {
        connection.signal?.throwIfAborted()
        const state = await this.readState()
        if (connection.id !== connectionId(state)) throw new LlmError('ChatGPT 连接已变更。', 'SIWC_CONNECTION_CHANGED')
        return Object.hasOwn(state.contextWindows, model.id) ? state.contextWindows[model.id] : undefined
      },
      ...runtime,
    })
  }
  private hydrateState(state: StoredState): StoredState {
    if (state.accountId) {
      this.capabilities.hydrate(deriveReplayScope(this.store.profileScope, state.accountId, state.grantEpoch ?? 1), state.capabilities)
    }
    return state
  }
  private async readState(): Promise<StoredState> {
    return this.hydrateState(await this.store.read())
  }
  private ensureDiagnosticsSecret(): Promise<void> {
    if (!this.requestDiagnostics) return Promise.resolve()
    return this.diagnosticsSecretReady ??= this.rotateDiagnosticsSecret(false)
  }
  private async connection(signal?: AbortSignal, rejectedAccessToken?: string): Promise<ProviderConnection> {
    const lifetime = this.connectionLifetime.signal
    const combined = AbortSignal.any([lifetime, this.lifetime.signal, ...(signal ? [signal] : [])])
    combined.throwIfAborted()
    await this.ensureDiagnosticsSecret()
    combined.throwIfAborted()
    const value = await this.store.connection(combined, rejectedAccessToken)
    combined.throwIfAborted()
    this.capabilities.hydrate(value.replayScope, value.capabilities)
    return { ...value, signal: combined }
  }
  private async authorize(options: GenerateOptions, connection: ProviderConnection): Promise<void> {
    connection.signal?.throwIfAborted()
    const state = await this.readState()
    if (!state.credential || connection.id !== connectionId(state)) {
      throw new LlmError('ChatGPT 连接已变更，请重新发起请求。', 'SIWC_CONNECTION_CHANGED')
    }
    if (this.availability === 'usage-limited') {
      throw new LlmError('ChatGPT 计划用量已达上限，请管理用量后刷新模型。', 'QUOTA')
    }
    authorizeCall(state, options)
  }
  private capture(error: unknown, affectConnection = true): void {
    if (error instanceof AuthError || error instanceof LlmError) this.error = error.message
    else this.error = 'ChatGPT 连接操作失败，请检查网络后重试。'
    if (!affectConnection) return
    this.availability = error instanceof ProviderError && error.providerCode === 'subscription_sharing_usage_limit_exceeded'
      ? 'usage-limited' : 'unavailable'
  }
  private async rotateDiagnosticsSecret(forceRotate: boolean): Promise<void> {
    try {
      const secret = await this.store.diagnosticsSecret(Date.now(), undefined, forceRotate)
      if (!this.lifetime.signal.aborted) this.requestDiagnostics?.rotateSecret(secret)
    } catch { /* Diagnostics secret rotation must not disrupt inference. */ }
  }
  private recordUsage(usage: TokenUsage, connection: ProviderConnection): void {
    if (!connection.accountId) return
    const cached = usage.cacheReadTokens ?? 0
    const write = usage.cacheWriteTokens ?? 0
    const totalInput = usage.inputTokens + cached + write
    this.usageWrites = this.usageWrites.then(() => this.store.recordUsage(connection.accountId!, {
      requests: 1, inputTokens: totalInput,
      outputTokens: usage.outputTokens, cachedTokens: cached,
      ...(usage.cacheReadTokens === undefined ? {} : {
        cacheMeasuredInputTokens: totalInput, cacheMeasuredTokens: usage.cacheReadTokens,
      }),
      ...(usage.cacheWriteTokens === undefined ? {} : {
        cacheWriteTokens: usage.cacheWriteTokens,
      }),
    })).catch(() => { this.error = '本地用量统计保存失败。' })
  }
  private resetConnection(): void {
    this.connectionLifetime.abort()
    this.connectionLifetime = new AbortController()
    this.adapter.clearModels()
    this.adapter.resetConnections()
    this.models = []
    this.availability = 'ready'
    this.error = undefined
  }
  private cancelAttempt(): void {
    this.attempt?.cancel()
    this.attempt = undefined
    this.signingIn = false
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.transition.then(action, action)
    this.transition = next.catch(() => {})
    return next
  }
  async queryDiagnostics(filter: DiagnosticsFilter): Promise<DiagnosticsSnapshot> {
    return this.diagnostics?.query(filter) ?? {retained: 0, limit: 2000, groups: [], reasons: [], recent: [], records: [], models: []}
  }
  async status(): Promise<SiwcStatus> {
    const { state, accounts } = await this.store.snapshot()
    this.hydrateState(state)
    return {
      quota: this.quota?.status(state.accountId),
      diagnostics: await this.diagnostics?.snapshot(),
      accounts, activeAccountId: state.accountId,
      authenticated: !!state.credential, signingIn: this.signingIn,
      email: state.registration?.displayEmail,
      planEnabled: state.credential?.grantedScopes.includes('chatgpt.tokens.use.direct') ?? false,
      availability: this.availability, error: this.error,
      models: this.models.map(model => {
        const override = Object.hasOwn(state.contextWindows, model.id) ? state.contextWindows[model.id] : undefined
        const effective = override ?? model.defaultContextWindow
        return {...model, ...(effective === undefined ? {} : {contextWindow: effective}),
          ...(override === undefined ? {} : {contextWindowOverride: override})}
      }),
      authorizedSessions: state.authorizedSessions, allowBackground: state.allowBackground,
      ...(state.cacheSettings ? { cacheSettings: state.cacheSettings } : {}),
      usage: state.usage,
    }
  }
  beginSignIn(): Promise<SiwcStatus> { return this.startSignIn(false) }
  addAccount(): Promise<SiwcStatus> { return this.startSignIn(true) }
  reauthorizeAccount(accountId: string): Promise<SiwcStatus> { return this.startSignIn(false, accountId) }
  private async startSignIn(fresh: boolean, accountId?: string): Promise<SiwcStatus> {
    return this.serial(async () => {
      this.cancelAttempt()
      this.error = undefined
      this.signingIn = true
      try {
        const attempt = await this.auth.beginSignIn({ hostId: await this.store.hostId(),
          registration: fresh ? undefined : await this.store.returningRegistration(accountId), signal: this.lifetime.signal })
        this.attempt = attempt
        void attempt.completion.then(value => this.serial(async () => {
          if (this.attempt !== attempt || this.lifetime.signal.aborted) return
          await this.store.connect(value)
          const accountId = (await this.store.read()).accountId
          if (accountId) await this.quota?.clear(accountId)
          this.resetConnection()
          this.signingIn = false
          this.attempt = undefined
          if (value.grantedScopes.includes('chatgpt.tokens.use.direct')) await this.refreshModels()
        })).catch(error => {
          if (this.attempt !== attempt) return
          this.signingIn = false
          this.attempt = undefined
          this.capture(error, false)
        })
        await this.browser(attempt.authorizationUrl)
      } catch (error) {
        this.attempt?.cancel()
        this.attempt = undefined
        this.signingIn = false
        this.capture(error, false)
      }
      return this.status()
    })
  }
  async cancelSignIn(): Promise<SiwcStatus> {
    return this.serial(async () => {
      this.attempt?.cancel()
      this.attempt = undefined
      this.signingIn = false
      return this.status()
    })
  }
  async switchAccount(accountId: string): Promise<SiwcStatus> {
    return this.serial(async () => {
      try {
        await this.store.switchAccount(accountId)
        this.cancelAttempt()
        this.resetConnection()
        if ((await this.store.read()).credential?.grantedScopes.includes('chatgpt.tokens.use.direct')) {
          await this.refreshModels()
        }
      } catch (error) { this.capture(error) }
      return this.status()
    })
  }
  async removeAccount(accountId: string): Promise<SiwcStatus> {
    return this.serial(() => this.disconnect(accountId))
  }
  async signOut(): Promise<SiwcStatus> {
    return this.serial(async () => {
      const id = await this.store.activeAccountId()
      if (id) return this.disconnect(id)
      this.cancelAttempt()
      return this.status()
    })
  }
  private async disconnect(accountId: string): Promise<SiwcStatus> {
    this.cancelAttempt()
    const active = await this.store.activeAccountId() === accountId
    if (active) {
      this.connectionLifetime.abort()
      this.adapter.resetConnections()
    }
    try {
      const revoked = await this.store.removeAccount(accountId)
      await this.quota?.clear(accountId)
      if (active) this.resetConnection()
      if (active && (await this.store.read()).credential?.grantedScopes.includes('chatgpt.tokens.use.direct')) {
        await this.refreshModels()
      }
      if (!revoked) this.error = '已退出本机连接；远程撤销尚未确认，可在 ChatGPT 设置中断开应用。'
    } catch (error) {
      if (active) this.resetConnection()
      this.capture(error)
    }
    return this.status()
  }
  async refreshModels(): Promise<SiwcStatus> {
    const lifetime = this.connectionLifetime.signal
    try {
      const models = await this.adapter.refreshModels(AbortSignal.any([lifetime, AbortSignal.timeout(20_000)]))
      lifetime.throwIfAborted()
      this.models = models.map(model => ({id: model.id, name: model.name ?? model.id,
        ...(model.context?.contextWindow === undefined ? {} : {defaultContextWindow: model.context.contextWindow}),
        ...(model.maxContextWindow === undefined ? {} : {maxContextWindow: model.maxContextWindow}),
      }))
      this.error = undefined
      this.availability = 'ready'
    } catch (error) { if (!lifetime.aborted) this.capture(error) }
    return this.status()
  }
  async setContextWindow(setting: ContextWindowSetting): Promise<SiwcStatus> {
    return this.serial(async () => {
      const model = this.models.find(model => model.id === setting.modelId)
      if (!model) throw new LlmError('请先刷新模型目录并选择模型。', 'SIWC_MODEL_UNAVAILABLE')
      const value = setting.contextWindow
      if (value !== null && (!Number.isSafeInteger(value) || value <= 0 ||
        (model.maxContextWindow !== undefined && value > model.maxContextWindow))) {
        throw new LlmError('上下文窗口须为正整数，且不超过服务端提供的最大值。', 'SIWC_INVALID_CONTEXT_WINDOW')
      }
      await this.store.update(state => {
        if (state.accountId !== setting.accountId || !state.credential) {
          throw new LlmError('当前账号已变更，请刷新后重试。', 'SIWC_CONNECTION_CHANGED')
        }
        if (value === null) delete state.contextWindows[setting.modelId]
        else state.contextWindows = {...state.contextWindows, [setting.modelId]: value}
      })
      return this.status()
    })
  }
  async probeModel(modelId: string): Promise<SiwcStatus> {
    const lifetime = this.connectionLifetime.signal
    try {
      const connection = await this.connection(AbortSignal.timeout(30_000))
      const adapter = new ChatGPTSiwcAdapter({ diagnostics: this.requestDiagnostics, diagnosticCategory: 'connection-test', connection: async (signal, rejected) => {
        if (!rejected) return connection
        const renewed = await this.connection(signal, rejected)
        if (renewed.id !== connection.id) throw new LlmError('ChatGPT 连接已变更。', 'SIWC_CONNECTION_CHANGED')
        return renewed
      }, authorize: async () => {},
        onUsage: usage => this.recordUsage(usage, connection) })
      try {
        const call = await adapter.prepareCall('chatgpt-siwc', modelId, connection.signal)
        for await (const _chunk of call.stream({ provider: 'chatgpt-siwc', model: modelId, messages: [{role: 'user', content: [{type: 'text', text: 'Reply with OK.'}]}], signal: connection.signal })) {}
      } finally { adapter.dispose() }
      lifetime.throwIfAborted()
      const model = this.models.find(value => value.id === modelId)
      if (model) model.verified = true
      this.error = undefined
      this.availability = 'ready'
    } catch (error) { if (!lifetime.aborted) this.capture(error) }
    return this.status()
  }
  async authorizeSession(sessionId: string): Promise<SiwcStatus> {
    if (!this.header(sessionId)) throw new Error('会话不存在，请重新打开会话。')
    await this.store.update(state => {
      if (!state.authorizedSessions.includes(sessionId)) state.authorizedSessions.push(sessionId)
    })
    return this.status()
  }
  async revokeSession(sessionId: string): Promise<SiwcStatus> {
    await this.store.update(state => { state.authorizedSessions = state.authorizedSessions.filter(id => id !== sessionId) })
    return this.status()
  }
  async setBackgroundAllowed(allowed: boolean): Promise<SiwcStatus> {
    await this.store.update(state => { state.allowBackground = allowed })
    return this.status()
  }
  async setCacheSettings(settings: CacheSettings): Promise<SiwcStatus> {
    await this.store.setCacheSettings(settings)
    return this.status()
  }
  async linkCodexQuota(setting: QuotaLinkSetting): Promise<SiwcStatus> {
    if (!this.quota) throw new Error('额度服务尚未就绪。')
    await this.quota.linkCodex(setting.accountId, setting.sourceKey)
    return this.status()
  }
  async unlinkCodexQuota(accountId: string): Promise<SiwcStatus> {
    await this.quota?.unlinkCodex(accountId)
    return this.status()
  }
  async refreshQuota(): Promise<SiwcStatus> { await this.quota?.refresh(); return this.status() }
  async connectCodexQuota(): Promise<SiwcStatus> { await this.quota?.connectCodex(); return this.status() }
  async cancelCodexQuota(): Promise<SiwcStatus> { await this.quota?.cancelCodex(); return this.status() }
  async disconnectCodexQuota(): Promise<SiwcStatus> { await this.quota?.disconnectCodex(); return this.status() }
  async dispose(): Promise<void> {
    this.lifetime.abort()
    await this.quota?.dispose()
    this.adapter.dispose()
    this.attempt?.cancel()
    await this.transition
    await this.usageWrites
    await this.requestDiagnostics?.flushBaselines()
    await this.diagnostics?.dispose()
  }
}

function latestConfirmedResponseId(messages: GenerateOptions['messages'], replayScope: string, connection: ProviderConnection): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== 'assistant') continue
    const response = (message.source?.replayState as {
      response?: { responseId?: unknown; replayScope?: unknown; connectionId?: unknown }
    } | undefined)?.response
    if (!response || typeof response.responseId !== 'string' || !response.responseId) continue
    const scopeMatched = typeof response.replayScope === 'string'
      ? response.replayScope === replayScope
      : response.connectionId === connection.id ||
        (connection.legacyConnectionId !== undefined && response.connectionId === connection.legacyConnectionId)
    if (scopeMatched) return response.responseId
  }
  return undefined
}
