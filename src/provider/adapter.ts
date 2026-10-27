import type { CacheSettings } from '../storage/state.js'
import type { RequestDiagnostics, RequestTrace } from '../diagnostics/requests.js'
import type { RequestCategory, RequestDiagnostic } from '../diagnostics/types.js'
import {
  LlmAdapter, LlmError, attributionHeaders, resolveRetryPolicy,
  type GenerateOptions, type LlmModelInfo, type LlmResolvedModelInfo, type StreamChunk, type TokenUsage,
  type ImageAttachmentAccessResolver,
} from '@deepseek-ai/dsh-llm'
import { CapabilityRegistry, requestCapabilityProbes, type CapabilityProbe, type CapabilityStatus, type ProviderCapability } from './capabilities.js'
import { fetchCatalog, type CatalogModel } from './catalog.js'
import { checkResponse, ProviderError } from './errors.js'
import { buildRequest, type RequestEnhancements, type ResolveImage } from './request.js'
import { parseEvents, parseUsage } from './stream.js'
import { readResponseEvents } from './sse.js'
import type { DurabilityDiagnostic } from './durability.js'
import type { ReplayContext } from './replay.js'
import { requestSessionId, resolveReplayScope } from './session.js'
import { authenticatedFetch } from './http.js'
import { createAttemptBudget, ResponsesTransport, type AttemptBudget, type SocketFactory } from './transport/index.js'

export interface ProviderConnection {
  id: string; accountId?: string; grantEpoch?: number; activeGeneration?: number; credentialGeneration?: number
  replayScope?: string; legacyConnectionId?: string; accessToken: string; signal?: AbortSignal
  cacheSettings?: CacheSettings
}

export interface ProviderDependencies {
  diagnostics?: RequestDiagnostics
  diagnosticCategory?: RequestCategory
  connection(signal?: AbortSignal, rejectedAccessToken?: string): Promise<ProviderConnection>
  authorize(options: GenerateOptions, connection: ProviderConnection): Promise<void>
  image?: ResolveImage
  imageAccess?: ImageAttachmentAccessResolver
  contextWindow?(connection: ProviderConnection, model: CatalogModel): Promise<number | undefined>
  sessionKind?(options: GenerateOptions): 'conversation' | 'subagent' | 'other'
  onUsage?(usage: TokenUsage, connection: ProviderConnection): void
  onError?(error: ProviderError, connection: ProviderConnection): void
  enhancements?: RequestEnhancements | ((options: GenerateOptions, connection: ProviderConnection) => RequestEnhancements | undefined)
  capabilities?: CapabilityRegistry
  onCapability?(model: string, capability: ProviderCapability, status: CapabilityStatus, connection: ProviderConnection): void | Promise<void>
  fetch?: typeof fetch
  sessionScope?: string
  confirmedResponses?(options: GenerateOptions, context: ReplayContext, observe?: (value: DurabilityDiagnostic) => void): Promise<ReadonlySet<string>>
  websocket?: boolean
  socketFactory?: SocketFactory
}

export class ChatGPTSiwcAdapter extends LlmAdapter {
  private catalogs = new Map<string, readonly CatalogModel[]>()
  private fetcher: typeof fetch
  private readonly transport: ResponsesTransport
  readonly capabilities: CapabilityRegistry

  constructor(private readonly dependencies: ProviderDependencies) {
    super()
    this.fetcher = dependencies.fetch ?? fetch
    this.capabilities = dependencies.capabilities ?? new CapabilityRegistry()
    this.transport = new ResponsesTransport({
      headers: attributionHeaders(), socketFactory: dependencies.socketFactory,
      http: (body, headers, signal, connectionId, budget) => this.http(body, headers, signal, connectionId, budget),
    })
  }

  override providerInfo(provider: string) { return { id: provider, name: 'ChatGPT', description: '正在使用 ChatGPT 计划' } }
  override providerRetryPolicy() {
    const policy = resolveRetryPolicy(undefined, 'chatgpt-siwc.retryPolicy')
    if (policy.mode !== 'normal') return policy
    return Object.freeze({
      ...policy,
      retryableCodes: Object.freeze([...policy.retryableCodes, 'SIWC_SOCKET_INTERRUPTED']),
    })
  }
  clearModels(): void { this.catalogs.clear() }
  resetConnections(): void { this.transport.invalidate() }
  notifyNetworkChange(): void { this.transport.notifyNetworkChange() }
  dispose(): void { this.transport.dispose(); this.catalogs.clear() }

  async refreshModels(signal?: AbortSignal): Promise<readonly CatalogModel[]> {
    return this.catalog(await this.dependencies.connection(signal), true, signal)
  }

  override async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return this.catalog(await this.dependencies.connection())
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return this.resolve(await this.dependencies.connection(signal), provider, model, signal)
  }

  override async prepareCall(provider: string, model: string, signal?: AbortSignal) {
    const connection = await this.dependencies.connection(signal)
    return {
      model: await this.resolve(connection, provider, model, signal),
      stream: (options: GenerateOptions) => this.streamConnection(connection, options, true),
    }
  }

  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    yield* this.streamConnection(await this.dependencies.connection(options.signal), options, false)
  }

  private async catalog(connection: ProviderConnection, refresh = false, signal?: AbortSignal) {
    const saved = this.catalogs.get(connection.id)
    if (saved && !refresh) return saved
    const result = await fetchCatalog(connection.accessToken, combineSignals(signal, connection.signal),
      (input, init) => authenticatedFetch(this.fetcher, this.dependencies.connection, connection.id, input, init))
    this.catalogs.set(connection.id, result)
    return result
  }

  private async resolve(connection: ProviderConnection, provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const selected = (await this.catalog(connection, false, signal)).find(item => item.id === model)
    if (!selected) throw new LlmError('该模型当前未列入 ChatGPT 账号目录，请刷新模型列表。', 'SIWC_MODEL_UNAVAILABLE')
    const contextWindow = await this.dependencies.contextWindow?.(connection, selected)
    combineSignals(signal, connection.signal)?.throwIfAborted()
    if (contextWindow !== undefined && (!Number.isSafeInteger(contextWindow) || contextWindow <= 0 ||
      selected.maxContextWindow !== undefined && contextWindow > selected.maxContextWindow)) {
      throw new LlmError('上下文窗口必须是正整数，且不得超过此账号模型支持的最大窗口。', 'SIWC_INVALID_CONTEXT_WINDOW')
    }
    const replayScope = resolveReplayScope(this.dependencies.sessionScope ?? 'standalone', connection)
    // DSH must retain tool-update history for the first probe as well as supported calls.
    const supportsAdditions = connection.cacheSettings?.toolAdditions === true &&
      this.capabilities.isAllowed(replayScope, model, 'additional_tools')
    return {
      ...selected, provider, systemPromptUpdate: 'in-history',
      ...(supportsAdditions ? { toolUpdate: 'addition-only' as const } : {}),
      ...(contextWindow === undefined ? {} : { context: { contextWindow } }),
    }
  }

  private async resolveActiveConnection(prepared: ProviderConnection, optionsSignal?: AbortSignal, fromPrepare = false): Promise<ProviderConnection> {
    if (!fromPrepare || (prepared.activeGeneration === undefined && prepared.credentialGeneration === undefined && prepared.grantEpoch === undefined)) {
      return prepared
    }
    const latest = await this.dependencies.connection(combineSignals(optionsSignal, prepared.signal))
    if (latest.id !== prepared.id || latest.accountId !== prepared.accountId ||
      (prepared.grantEpoch !== undefined && latest.grantEpoch !== prepared.grantEpoch) ||
      (prepared.activeGeneration !== undefined && latest.activeGeneration !== prepared.activeGeneration)) {
      throw new LlmError('ChatGPT 连接已变更，请重新发起请求。', 'SIWC_CONNECTION_CHANGED')
    }
    return { ...prepared, ...latest, signal: combineSignals(prepared.signal, latest.signal) }
  }

  private filterEnhancements(replayScope: string, model: string, raw?: RequestEnhancements): RequestEnhancements | undefined {
    if (!raw) return undefined
    const next: RequestEnhancements = { ...raw }
    if (next.cacheOptions && !this.capabilities.isAllowed(replayScope, model, 'prompt_cache_options')) {
      next.cacheOptions = next.cacheOptions.cacheKey ? { cacheKey: next.cacheOptions.cacheKey } : undefined
    }
    if (!this.capabilities.isAllowed(replayScope, model, 'configuration_update')) next.configurationUpdate = false
    if (!this.capabilities.isAllowed(replayScope, model, 'additional_tools')) next.toolUpdate = undefined
    return next
  }

  private async *streamConnection(prepared: ProviderConnection, options: GenerateOptions, fromPrepare = false): AsyncGenerator<StreamChunk> {
    let connection = prepared
    let signal = combineSignals(options.signal, connection.signal)
    let trace: RequestTrace | undefined
    let outcome: RequestDiagnostic['outcome'] = 'cancelled'
    let replayScope = resolveReplayScope(this.dependencies.sessionScope ?? 'standalone', connection)
    let recordTerminalUsage: ((usage: TokenUsage, responseId?: string) => void) | undefined
    try {
      signal?.throwIfAborted()
      connection = await this.resolveActiveConnection(prepared, options.signal, fromPrepare)
      signal = combineSignals(options.signal, connection.signal)
      replayScope = resolveReplayScope(this.dependencies.sessionScope ?? 'standalone', connection)
      trace = this.dependencies.diagnostics?.begin(connection, options, this.dependencies.diagnosticCategory)
      signal?.throwIfAborted()
      await this.dependencies.authorize(options, connection)
      const model = (await this.catalog(connection, false, signal)).find(model => model.id === options.model)
      if (!model) throw new LlmError('该模型当前未列入 ChatGPT 账号目录。', 'SIWC_MODEL_UNAVAILABLE')
      validateCapabilities(model, options)
      const sessionId = requestSessionId(this.dependencies.sessionScope ?? 'standalone', replayScope, options)
      trace?.wireSession(sessionId)
      const context: ReplayContext = {
        connectionId: connection.id, replayScope, model: options.model, sessionId, wireSessionId: sessionId,
        ...(connection.legacyConnectionId ? { legacyConnectionId: connection.legacyConnectionId } : {}),
        ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
      }
      const rawEnhancements = typeof this.dependencies.enhancements === 'function'
        ? this.dependencies.enhancements(options, connection) : this.dependencies.enhancements
      const confirmedResponseIds = options.sessionId && this.dependencies.websocket !== false
        ? await this.dependencies.confirmedResponses?.({ ...options, signal }, context, value => trace?.durability(value)) : undefined
      signal?.throwIfAborted()
      const budget = createAttemptBudget()
      const seenUsageKeys = new Set<string>()
      let attemptUsageCounted = false
      let lastResponseId: string | undefined
      recordTerminalUsage = (usage: TokenUsage, responseId = lastResponseId) => {
        trace?.usage(usage)
        const accountKey = connection.accountId ?? connection.id
        const dedupKey = responseId ? `${accountKey}:${responseId}` : undefined
        if (dedupKey && seenUsageKeys.has(dedupKey)) return
        if (!dedupKey && attemptUsageCounted) return
        attemptUsageCounted = true
        if (dedupKey) seenUsageKeys.add(dedupKey)
        this.dependencies.onUsage?.(usage, connection)
      }
      const useSocket = options.sessionId && this.dependencies.websocket !== false
      if (!useSocket) trace?.decision({mode: 'http', reason: options.sessionId ? 'websocket-disabled' : 'independent-call'})
      while (true) {
        const enhancements = this.filterEnhancements(replayScope, options.model, rawEnhancements)
        const { body, identities, replayStats } = await buildRequest(
          { ...options, signal }, context, this.dependencies.image, this.dependencies.imageAccess, enhancements,
        )
        trace?.replay(replayStats)
        trace?.body(body)
        attemptUsageCounted = false
        lastResponseId = undefined
        let observedOutput = false
        let sentCapabilities: CapabilityProbe[] = []
        const onRequestBody = (wireBody: Record<string, unknown>) => {
          sentCapabilities = requestCapabilityProbes(wireBody)
        }
        try {
          const events = useSocket
            ? this.transport.stream({
                body, sessionId, connectionId: connection.id, accessToken: connection.accessToken,
                credentialGeneration: connection.credentialGeneration, signal, confirmedResponseIds,
                sessionKind: this.dependencies.sessionKind?.(options), budget, onRequestBody,
                onDecision: decision => { attemptUsageCounted = false; trace?.decision(decision) },
                onDisconnect: trace?.disconnect,
                onTiming: (stage, ts) => { if (stage === 'request-sent') attemptUsageCounted = false; trace?.timing(stage, ts) },
              })
            : this.httpEvents(body, sessionId, connection, signal, budget, trace, onRequestBody)
          for await (const chunk of parseEvents(this.observeEvents(events, trace, (usage, responseId) => {
            lastResponseId = responseId ?? lastResponseId
            recordTerminalUsage?.(usage, responseId)
          }), identities, context, signal)) {
            if (chunk.type === 'usage') recordTerminalUsage?.(chunk.usage, lastResponseId)
            else if (chunk.type === 'finish') {
              outcome = 'completed'
              for (const {capability: cap} of sentCapabilities) {
                const previous = this.capabilities.status(replayScope, options.model, cap)
                this.capabilities.record(replayScope, options.model, cap, 'supported')
                if (previous === 'unknown') await this.dependencies.onCapability?.(options.model, cap, 'supported', connection)
              }
            } else {
              observedOutput = true
            }
            yield chunk
          }
          break
        } catch (error) {
          if (error instanceof ProviderError && error.event) {
            this.inspectTerminalEvent(error.event, trace, recordTerminalUsage)
          }
          let unsupportedMatched = false
          if (!observedOutput) {
            for (const {capability: cap} of sentCapabilities) {
              if (this.capabilities.recordError(replayScope, options.model, cap, error, sentCapabilities)) {
                unsupportedMatched = true
                await this.dependencies.onCapability?.(options.model, cap, 'unsupported', connection)
              }
            }
          }
          if (!observedOutput && unsupportedMatched && budget.sendsUsed < budget.maxSends && !signal?.aborted) {
            continue
          }
          throw error
        }
      }
    } catch (error) {
      outcome = signal?.aborted ? 'cancelled' : 'failed'
      if (error instanceof ProviderError) this.dependencies.onError?.(error, connection)
      throw error
    } finally { trace?.finish(outcome) }
  }

  private inspectTerminalEvent(event: Record<string, unknown>, trace?: RequestTrace,
    onTerminalUsage?: (usage: TokenUsage, responseId?: string) => void): void {
    trace?.event(event)
    const type = String(event.type ?? '')
    if (type === 'response.completed' || type === 'response.failed' || type === 'response.incomplete' || type === 'error') {
      const resp = event.response && typeof event.response === 'object' ? event.response as Record<string, unknown> : undefined
      const usage = parseUsage(resp?.usage ?? event.usage)
      const responseId = typeof resp?.id === 'string' && resp.id ? resp.id : undefined
      if (usage) onTerminalUsage?.(usage, responseId)
    }
  }

  private async *observeEvents(events: AsyncIterable<Record<string, unknown>>, trace?: RequestTrace,
    onTerminalUsage?: (usage: TokenUsage, responseId?: string) => void) {
    for await (const event of events) {
      this.inspectTerminalEvent(event, trace, onTerminalUsage)
      yield event
    }
  }

  private http(body: Record<string, unknown>, headers: Record<string, string>, signal: AbortSignal | undefined, connectionId: string, budget?: AttemptBudget) {
    return authenticatedFetch(this.fetcher, this.dependencies.connection, connectionId,
      'https://api.openai.com/v1/responses', { method: 'POST', signal,
        headers: { ...headers, 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(body) }, budget)
  }

  private async *httpEvents(body: Record<string, unknown>, sessionId: string, connection: ProviderConnection, signal: AbortSignal | undefined, budget: AttemptBudget, trace?: RequestTrace,
    onRequestBody?: (body: Record<string, unknown>) => void) {
    signal?.throwIfAborted()
    if (budget.sendsUsed >= budget.maxSends) throw new LlmError('ChatGPT 请求重试次数已达上限。', 'SIWC_RETRY_EXHAUSTED')
    budget.sendsUsed++
    budget.attempt++
    onRequestBody?.(body)
    trace?.timing('request-sent')
    const response = await this.http(body, { ...attributionHeaders(), authorization: `Bearer ${connection.accessToken}`,
      'session-id': sessionId }, signal, connection.id, budget)
    await checkResponse(response)
    for await (const event of readResponseEvents(response, signal)) {
      yield event
    }
  }
}

function validateCapabilities(model: CatalogModel, options: GenerateOptions): void {
  if (options.reasoningEffort && model.reasoning && !model.reasoning.efforts.some(effort => effort.id === options.reasoningEffort)) {
    throw new LlmError('所选推理强度未列入该账号的模型能力。', 'SIWC_UNSUPPORTED_REASONING')
  }
  if (model.imageInput === false && options.messages.some(message => message.content.some(block => block.type === 'image' && !block.offloaded))) {
    throw new LlmError('该账号目录声明所选模型不支持图片输入。', 'UNSUPPORTED_CONTENT')
  }
}

function combineSignals(first?: AbortSignal, second?: AbortSignal): AbortSignal | undefined {
  const signals = [first, second].filter((signal): signal is AbortSignal => signal !== undefined)
  return signals.length ? AbortSignal.any(signals) : undefined
}
