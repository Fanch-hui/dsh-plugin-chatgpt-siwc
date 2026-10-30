import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import type { GenerateOptions, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { ProviderConnection } from '../provider/adapter.js'
import { classifyWireEvent } from '../provider/events.js'
import type { DisconnectDiagnostic, TransportDecision } from '../provider/transport/index.js'
import { BaselineStore, maxBaselineItems, type PrefixBaseline } from './baselines.js'
import { withinFingerprintBudget } from './budget.js'
import { observeEvent, requestMetadata, usageObservation } from './observations.js'
import type { DiagnosticsStore } from './store.js'
import type { RequestCategory, RequestDiagnostic, SystemPromptSource } from './types.js'

export interface DiagnosticSecret { keyId: string; secret: Buffer | Uint8Array | string; expiresAt?: number }
export interface RequestDiagnosticsOptions { profileDir?: string; secret?: DiagnosticSecret; onSecretExpired?: () => void }
export type TimingStage = 'request-ready' | 'handshake-start' | 'handshake-end' | 'request-sent' | 'first-event' | 'first-content' | 'first-text' | 'terminal'

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item) ?? 'null'
}
function key(value: unknown): string { return createHash('sha256').update(stable(value)).digest('hex') }

/** Only keyed fingerprints survive request preparation; no text is retained by this observer. */
export class RequestDiagnostics {
  private secret: Buffer | Uint8Array | string
  private keyId?: string
  private secretExpiresAt?: number
  private readonly onSecretExpired?: () => void
  private readonly runtimeId = randomUUID()
  private readonly baselines: BaselineStore

  constructor(private readonly store: Pick<DiagnosticsStore, 'record'>,
    private readonly classify: (options: GenerateOptions) => RequestCategory, options?: RequestDiagnosticsOptions) {
    this.onSecretExpired = options?.onSecretExpired
    const now = Date.now()
    if (options?.secret && (options.secret.expiresAt === undefined || now < options.secret.expiresAt)) {
      this.secret = options.secret.secret; this.keyId = options.secret.keyId; this.secretExpiresAt = options.secret.expiresAt
    } else if (options?.secret) {
      this.onSecretExpired?.(); this.secret = randomBytes(32); this.keyId = randomUUID().slice(0, 16)
    } else {
      this.secret = randomBytes(32); this.keyId = undefined
    }
    this.baselines = new BaselineStore(options?.profileDir, this.keyId)
  }

  private ensureValidSecret(now = Date.now()): {secret: Buffer | Uint8Array | string; keyId: string} {
    if (this.secretExpiresAt !== undefined && now >= this.secretExpiresAt) {
      this.secret = randomBytes(32); this.keyId = randomUUID().slice(0, 16); this.secretExpiresAt = undefined
      this.baselines.rotateKey(this.keyId); this.onSecretExpired?.()
    } else if (!this.keyId) {
      this.keyId = randomUUID().slice(0, 16); this.baselines.rotateKey(this.keyId)
    }
    return {secret: this.secret, keyId: this.keyId}
  }

  rotateSecret(secret: DiagnosticSecret): void {
    this.secret = secret.secret; this.keyId = secret.keyId; this.secretExpiresAt = secret.expiresAt
    this.baselines.rotateKey(this.keyId)
  }
  async clearBaselines(): Promise<void> { await this.baselines.clear() }
  async flushBaselines(): Promise<void> { await this.baselines.flush() }

  begin(connection: ProviderConnection, options: GenerateOptions, category?: RequestCategory): RequestTrace {
    const startedAt = Date.now()
    const {secret: requestSecret, keyId: requestKeyId} = this.ensureValidSecret(startedAt)
    const hash = (value: unknown) => createHmac('sha256', requestSecret).update(stable(value)).digest('hex')
    const accountKey = key(connection.accountId ?? connection.id)
    const record: RequestDiagnostic = {
      id: randomUUID(), runtimeId: this.runtimeId, keyId: requestKeyId, attemptId: randomUUID(),
      startedAt, durationMs: 0, accountKey,
      ...(options.sessionId ? {sessionKey: key([accountKey, options.sessionId])} : {}),
      model: options.model, category: category ?? this.classify(options), outcome: 'cancelled', sent: false,
      timings: {prepareStartedAt: startedAt}, transport: [],
    }
    const seenUsageKeys = new Set<string>()
    let commitRoute: (() => void) | undefined, commitPrefix: (() => void) | undefined
    let activePrefix: {lane: string; items: string[]} | undefined
    const commitPreparedBaselines = () => {
      if (commitRoute) { const fn = commitRoute; commitRoute = undefined; fn() }
      if (commitPrefix) { const fn = commitPrefix; commitPrefix = undefined; fn() }
    }
    return new RequestTrace(
      record,
      body => {
        const prepared = this.prefix(record, body, requestKeyId, hash)
        activePrefix = prepared?.activePrefix; commitPrefix = prepared?.commit
      },
      value => this.store.record(value),
      id => {
        commitRoute = this.routing(record, options, connection.id, id)
      },
      event => { observeEvent(record, event, hash); this.captureExpectedOutput(record, activePrefix, event, requestKeyId, hash, commitPreparedBaselines) },
      dedupKey => seenUsageKeys.has(dedupKey), dedupKey => { seenUsageKeys.add(dedupKey) }, commitPreparedBaselines,
    )
  }

  private routing(record: RequestDiagnostic, options: GenerateOptions, connection: string, wireSession: string): (() => void) | undefined {
    const wire = key(['wire-session', wireSession]), connectionHash = key(['connection', connection])
    const lane = options.sessionId ? key(['route', options.sessionId, record.category]) : undefined
    const candidate = lane ? this.baselines.getRoute(lane, record.startedAt) : undefined
    const previous = candidate && candidate.startedAt <= record.startedAt ? candidate : undefined
    record.routing = {wireSessionHash: wire, connectionHash,
      ...(previous ? {previousGapMs: Math.max(0, record.startedAt - previous.startedAt),
        accountChanged: previous.account !== record.accountKey, connectionChanged: previous.connection !== connectionHash,
        modelChanged: previous.model !== record.model, wireSessionChanged: previous.wire !== wire} : {})}
    if (!lane || (candidate && candidate.startedAt > record.startedAt)) return undefined
    return () => {
      const latest = this.baselines.getRoute(lane, record.startedAt)
      if (latest && latest.startedAt > record.startedAt) return
      this.baselines.setRoute({lane, startedAt: record.startedAt, updatedAt: Date.now(), account: record.accountKey,
        connection: connectionHash, model: record.model, wire, runtimeId: record.runtimeId,
        attemptId: record.attemptId, baselineRequestId: record.id}, record.startedAt)
    }
  }

  private prefix(record: RequestDiagnostic, body: Record<string, unknown>, requestKeyId: string,
    hash: (value: unknown) => string): {activePrefix?: {lane: string; items: string[]}; commit: () => void} | undefined {
    record.request = requestMetadata(body)
    const scope = key([record.accountKey, record.sessionKey ?? null, record.model, record.category])
    if (!withinFingerprintBudget(body)) {
      record.prefixSkipped = 'budget-exceeded'
      return {commit: () => {
        if (requestKeyId === this.keyId) this.baselines.deletePrefixScope(scope, record.startedAt)
      }}
    }
    const {input, instructions, tools, previous_response_id: _prev, stream: _stream, background: _bg, store: _store, prompt_cache_options, ...restSettings} = body
    const cacheOpts = prompt_cache_options && typeof prompt_cache_options === 'object' && !Array.isArray(prompt_cache_options)
      ? prompt_cache_options as Record<string, unknown> : undefined
    let normalizedCacheOpts: unknown = prompt_cache_options
    if (cacheOpts && 'comparison_response_id' in cacheOpts) {
      const {comparison_response_id: _cmp, ...restCache} = cacheOpts
      normalizedCacheOpts = Object.keys(restCache).length > 0 ? restCache : undefined
    }
    const semanticSettings = {...restSettings, ...(normalizedCacheOpts !== undefined ? {prompt_cache_options: normalizedCacheOpts} : {})}
    const policyHash = hash({retention: body.prompt_cache_retention ?? null, mode: cacheOpts?.mode ?? null, ttl: cacheOpts?.ttl ?? null})
    const rawInput = Array.isArray(input) ? input : []
    const devIndices: number[] = [], devItems: unknown[] = []
    rawInput.forEach((item, index) => {
      if (item && typeof item === 'object' && !Array.isArray(item) && (item as Record<string, unknown>).role === 'developer') {
        devIndices.push(index); devItems.push(item)
      }
    })
    const developerHashes = devItems.slice(0, 64).map(item => hash(item))
    const systemPromptSource: SystemPromptSource = typeof instructions === 'string' && instructions.length > 0
      ? 'system-field' : devItems.length > 0 ? (devIndices.some(idx => idx > 0) ? 'in-history' : 'leading-message') : 'none'
    const current = {scope, instructions: hash(instructions), tools: hash(tools),
      settings: hash(semanticSettings), policy: policyHash, items: rawInput.map(item => hash(item))}
    const lane = record.sessionKey ? scope : key([scope, current.instructions, current.tools])
    const candidate = this.baselines.getPrefix(lane, requestKeyId, record.startedAt)
    const previous = candidate && candidate.startedAt <= record.startedAt ? candidate : undefined
    let shared = 0
    if (previous) {
      record.baselineRequestId = previous.baselineRequestId
      while (shared < Math.min(previous.items.length, current.items.length) && previous.items[shared] === current.items[shared]) shared++
    }
    const expectedOutputMatched = previous?.expectedNextInputHashes
      ? (current.items.length >= previous.expectedNextInputHashes.length
        && previous.expectedNextInputHashes.every((itemHash, idx) => current.items[idx] === itemHash)) : undefined
    record.prefix = {
      instructionsHash: current.instructions, toolsHash: current.tools, settingsHash: current.settings,
      policyHash: current.policy, inputHash: hash(current.items), developerHashes, systemPromptSource,
      ...(expectedOutputMatched !== undefined ? {expectedOutputMatched} : {}), itemCount: current.items.length,
      change: !previous ? 'first' : shared < previous.items.length ? 'changed'
        : current.items.length === previous.items.length ? 'unchanged' : 'append',
      ...(previous ? {previousItemCount: previous.items.length, sharedItems: shared,
        ...(shared < Math.max(previous.items.length, current.items.length) ? {firstDifference: shared} : {}),
        instructionsChanged: previous.instructions !== current.instructions,
        toolsChanged: previous.tools !== current.tools, settingsChanged: previous.settings !== current.settings} : {}),
    }
    return {
      activePrefix: {lane, items: current.items},
      commit: () => {
        if (requestKeyId !== this.keyId) return
        const latest = this.baselines.getPrefix(lane, requestKeyId, record.startedAt)
        if (latest && latest.startedAt > record.startedAt) return
        if (current.items.length <= maxBaselineItems) {
          const entry: PrefixBaseline = {
            lane, scope, keyId: requestKeyId, startedAt: record.startedAt, updatedAt: Date.now(),
            baselineRequestId: record.id, runtimeId: record.runtimeId, attemptId: record.attemptId,
            instructions: current.instructions, tools: current.tools, settings: current.settings,
            policy: current.policy, developerHashes, systemPromptSource, items: current.items,
          }
          this.baselines.setPrefix(entry, record.startedAt)
        } else this.baselines.deletePrefix(lane, record.startedAt)
      },
    }
  }

  private captureExpectedOutput(record: RequestDiagnostic, activePrefix: {lane: string; items: string[]} | undefined,
    event: Record<string, unknown>, requestKeyId: string, hash: (value: unknown) => string, commitPreparedBaselines: () => void): void {
    if (event.type !== 'response.completed') return
    commitPreparedBaselines()
    if (!activePrefix || requestKeyId !== this.keyId) return
    const response = event.response && typeof event.response === 'object' && !Array.isArray(event.response)
      ? event.response as Record<string, unknown> : undefined
    if (!Array.isArray(response?.output) || !withinFingerprintBudget(response.output)) return
    const expected = [...activePrefix.items, ...response.output.map(item => hash(item))]
    if (expected.length > maxBaselineItems) return
    const current = this.baselines.getPrefix(activePrefix.lane, requestKeyId)
    if (!current || current.baselineRequestId !== record.id) return
    this.baselines.setPrefix({...current, updatedAt: Date.now(), expectedNextInputHashes: expected})
  }
}

export class RequestTrace {
  private readonly start = performance.now()
  private ended = false
  private attemptUsageCounted = false
  private lastCountedResponseHash?: string
  private attempt = 0
  private readonly terminalWrites = new Map<string, boolean>()
  private lastTerminalWriteKey?: string
  private incompleteCountedWrite = false
  private countedWrites = 0
  private cacheWriteTotal = 0

  constructor(private readonly record: RequestDiagnostic, private readonly prepare: (body: Record<string, unknown>) => void,
    private readonly save: (record: RequestDiagnostic) => void, private readonly observeWire: (id: string) => void,
    private readonly observeServer: (event: Record<string, unknown>) => void,
    private readonly hasSeenUsage: (key: string) => boolean = () => false,
    private readonly markSeenUsage: (key: string) => void = () => {},
    private readonly commitBaselines: () => void = () => {}) {}

  body(body: Record<string, unknown>): void { try { this.prepare(body); this.timing('request-ready') } catch { /* Observation must not alter inference. */ } }
  wireSession(id: string): void { try { this.observeWire(id) } catch { /* Observation must not alter inference. */ } }

  timing(stage: TimingStage, timestamp = Date.now()): void {
    try {
      const timings = this.record.timings ?? (this.record.timings = {})
      if (stage === 'request-ready') timings.requestReadyAt = timestamp
      else if (stage === 'handshake-start') { timings.handshakeStartedAt = timestamp; delete timings.handshakeCompletedAt }
      else if (stage === 'handshake-end') timings.handshakeCompletedAt = timestamp
      else if (stage === 'request-sent') {
        this.attempt++
        this.lastTerminalWriteKey = undefined
        this.record.sent = true
        this.commitBaselines()
        timings.requestSentAt = timestamp
        delete timings.firstServerEventAt; delete timings.firstContentAt; delete timings.firstTextAt
        delete timings.firstContentMs; delete timings.firstTextMs
        if (this.attemptUsageCounted) this.attemptUsageCounted = false
      } else if (stage === 'first-event') timings.firstServerEventAt ??= timestamp
      else if (stage === 'first-content') timings.firstContentAt ??= timestamp
      else if (stage === 'first-text') timings.firstTextAt ??= timestamp
      else if (stage === 'terminal') timings.terminalAt = timestamp
      if (timings.requestSentAt !== undefined && timings.firstContentAt !== undefined) timings.firstContentMs = Math.max(0, timings.firstContentAt - timings.requestSentAt)
      if (timings.requestSentAt !== undefined && timings.firstTextAt !== undefined) timings.firstTextMs = Math.max(0, timings.firstTextAt - timings.requestSentAt)
    } catch { /* Observation must not alter inference. */ }
  }

  replay(stats: NonNullable<RequestDiagnostic['replay']>): void {
    try {
      this.record.replay = {totalBlocks: stats.totalBlocks, nativeBlocks: stats.nativeBlocks, degradedBlocks: stats.degradedBlocks,
        ...(stats.reasons ? {reasons: [...stats.reasons]} : {})}
    } catch { /* Observation must not alter inference. */ }
  }

  event(event: Record<string, unknown>): void {
    try {
      this.record.sent = true
      this.commitBaselines()
      const now = Date.now(), type = String(event.type ?? ''), classification = classifyWireEvent(event)
      this.timing('first-event', now)
      const isTextDelta = (type === 'response.output_text.delta' || type === 'response.refusal.delta') && typeof event.delta === 'string' && event.delta.length > 0
      const doneText = event.text ?? event.refusal
      const isTextDone = (type === 'response.output_text.done' || type === 'response.refusal.done') && typeof doneText === 'string' && doneText.length > 0
      const isMessageDone = classification.category === 'item-done' && classification.emitsOutput && (event.item as Record<string, unknown> | undefined)?.type === 'message'
      const firstText = isTextDelta || isTextDone || isMessageDone
      const firstContent = firstText || (classification.emitsOutput && !classification.terminal)
        || (type === 'response.reasoning_text.delta' && typeof event.delta === 'string' && event.delta.length > 0)
      if (firstContent) this.timing('first-content', now)
      if (firstText) this.timing('first-text', now)
      if (classification.terminal) this.timing('terminal', now)
      this.observeServer(event)
      if (classification.terminal) this.observeTerminalWrite(event)
    } catch { /* Observation must not alter inference. */ }
  }

  durability(summary: NonNullable<RequestDiagnostic['durability']>): void {
    try { this.record.durability = {reason: summary.reason, candidates: summary.candidates, confirmed: summary.confirmed} }
    catch { /* Observation must not alter inference. */ }
  }
  decision = (decision: TransportDecision | RequestDiagnostic['transport'][number]): void => {
    if (this.attemptUsageCounted) this.attemptUsageCounted = false
    this.record.transport.push({...decision})
  }
  disconnect = (disconnect: DisconnectDiagnostic | NonNullable<RequestDiagnostic['disconnect']>): void => {
    try { this.record.disconnect = {...disconnect} } catch { /* Observation must not alter inference. */ }
  }
  private observeTerminalWrite(event: Record<string, unknown>): void {
    const response = event.response && typeof event.response === 'object' && !Array.isArray(event.response)
      ? event.response as Record<string, unknown> : undefined
    const responseHash = typeof response?.id === 'string' && response.id.length <= 512
      ? this.record.server?.responseIdHash : undefined
    const key = responseHash ? `response:${responseHash}` : `attempt:${this.attempt}`
    this.lastTerminalWriteKey = key
    const observation = usageObservation(response?.usage ?? event.usage)
    const complete = observation.usage === 'reported' && observation.reportedCacheWriteTokens !== undefined
    if (!this.terminalWrites.has(key) || complete) this.terminalWrites.set(key, complete)
    this.updateCacheWrite()
  }

  private updateCacheWrite(): void {
    if (this.incompleteCountedWrite || [...this.terminalWrites.values()].includes(false)) {
      this.record.cacheWriteIncomplete = true
      delete this.record.cacheWriteTokens
      return
    }
    delete this.record.cacheWriteIncomplete
    if (this.countedWrites) this.record.cacheWriteTokens = this.cacheWriteTotal
  }

  usage(usage: TokenUsage): void {
    const responseHash = this.record.server?.responseIdHash
    const dedupKey = responseHash ? `${this.record.accountKey}:${responseHash}` : undefined
    if (dedupKey && this.hasSeenUsage(dedupKey)) return
    if (this.attemptUsageCounted && responseHash === this.lastCountedResponseHash) return
    this.attemptUsageCounted = true; this.lastCountedResponseHash = responseHash
    if (dedupKey) this.markSeenUsage(dedupKey)
    if (usage.cacheWriteTokens !== undefined && this.lastTerminalWriteKey) {
      this.terminalWrites.set(this.lastTerminalWriteKey, true)
    }
    const cached = usage.cacheReadTokens ?? 0, write = usage.cacheWriteTokens ?? 0
    this.record.inputTokens = (this.record.inputTokens ?? 0) + usage.inputTokens + cached + write
    if (usage.cacheReadTokens !== undefined) this.record.cachedTokens = (this.record.cachedTokens ?? 0) + cached
    if (usage.cacheWriteTokens === undefined) this.incompleteCountedWrite = true
    else { this.countedWrites++; this.cacheWriteTotal += write }
    this.updateCacheWrite()
    this.record.outputTokens = (this.record.outputTokens ?? 0) + usage.outputTokens
  }
  finish(outcome: RequestDiagnostic['outcome']): void {
    if (this.ended) return
    this.ended = true
    if (outcome === 'completed') {
      this.record.sent = true
      this.commitBaselines()
    }
    this.timing('terminal')
    this.record.durationMs = Math.max(0, Math.round(performance.now() - this.start))
    this.record.outcome = outcome
    if (!this.record.transport.length) this.decision({mode: 'not-started', reason: 'not-started'})
    try { this.save(this.record) } catch { /* Diagnostics storage owns its failure status. */ }
  }
}
