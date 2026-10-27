import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { credentialKey, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { z } from 'zod'
import { AuthError, SiwcAuth, type Credential, type Registration } from '../auth/index.js'

import { accountId, cacheSettings, credential, decode, emptyPreferences, project, registration,
  type AccountState, type CacheSettings, type CapabilityEntry, type CapabilityStatus, type StoredState, type Usage } from './accounts.js'
export type { CacheSettings, CapabilityEntry, CapabilityStatus, StoredState } from './accounts.js'

export interface PublicAccount {id: string; email?: string; authenticated: boolean; planEnabled: boolean}
export interface ConnectionValue {
  id: string; accountId: string; accessToken: string; grantEpoch: number
  activeGeneration: number; credentialGeneration: number; replayScope: string; legacyConnectionId?: string
  capabilities?: StoredState['capabilities']; cacheSettings?: CacheSettings
}
export interface DiagnosticsSecretRecord {
  keyId: string; secret: Buffer; createdAt: number; expiresAt: number
}

export function deriveReplayScope(profileScope: string, accountId: string, grantEpoch = 1): string {
  return createHash('sha256').update(JSON.stringify(['dsh-siwc-replay-scope-v1', profileScope, accountId, grantEpoch])).digest('hex')
}

function publicAccounts(state: AccountState): PublicAccount[] {
  return state.accounts.map(account => ({id: account.id,
    ...(account.registration?.displayEmail ? {email: account.registration.displayEmail} : {}),
    authenticated: !!account.credential,
    planEnabled: account.credential?.grantedScopes.includes('chatgpt.tokens.use.direct') ?? false}))
}

export function connectionId(state: StoredState): string {
  return `${state.accountId ?? 'disconnected'}:${state.revision}`
}
function connectionValue(state: StoredState, profileScope: string): ConnectionValue {
  const grantEpoch = state.grantEpoch ?? 1
  const credentialGeneration = state.credentialGeneration ?? 1
  const id = state.accountId!
  return {
    id: connectionId(state), accountId: id, accessToken: state.credential!.accessToken,
    grantEpoch, activeGeneration: state.revision, credentialGeneration,
    replayScope: deriveReplayScope(profileScope, id, grantEpoch),
    ...(state.legacyConnectionId ? {legacyConnectionId: state.legacyConnectionId} : {}),
    ...(state.capabilities ? {capabilities: state.capabilities} : {}),
    ...(state.cacheSettings ? {cacheSettings: state.cacheSettings} : {}),
  }
}

function usable(value: Credential, rejectedAccessToken?: string): boolean {
  return value.accessToken !== rejectedAccessToken && value.expiresAt > Date.now()
}

async function waitForConnection<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation
  // A cancelled request stops waiting while rotating credentials still commit.
  void operation.catch(() => {})
  signal.throwIfAborted()
  let cancel!: () => void
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason)
    signal.addEventListener('abort', cancel, { once: true })
  })
  try { return await Promise.race([operation, cancelled]) }
  finally { signal.removeEventListener('abort', cancel) }
}

/** Every mutation uses DSH's cross-process read/modify/write transaction. */
export class ConnectionStore {
  private readonly key
  private readonly diagnosticsKey
  readonly profileScope: string
  constructor(private readonly provider: Pick<CredentialProvider, 'readRecord' | 'modifyRecord'>, profileDir: string,
    private readonly auth: Pick<SiwcAuth, 'refresh' | 'revoke'>) {
    this.profileScope = createHash('sha256').update(profileDir).digest('hex')
    this.key = credentialKey('chatgpt-siwc', `profile-${this.profileScope}`)
    this.diagnosticsKey = credentialKey('chatgpt-siwc', `diagnostics-${this.profileScope}`)
  }
  async hostId(): Promise<string> {
    const record = await this.provider.modifyRecord(credentialKey('chatgpt-siwc', 'host'), async current => {
      if (current) return undefined
      return { kind: 'grant', payload: { hostId: `urn:uuid:${randomUUID()}` } }
    })
    const result = z.object({hostId: z.string().min(1)}).safeParse(record?.kind === 'grant' ? record.payload : undefined)
    if (!result.success) throw new Error('ChatGPT 主机标识记录无效。')
    return result.data.hostId
  }
  async diagnosticsSecret(now = Date.now(), ttlMsOrProfileKey?: number | string, forceRotate = false): Promise<DiagnosticsSecretRecord> {
    const ttlMs = typeof ttlMsOrProfileKey === 'number' ? ttlMsOrProfileKey : 24 * 60 * 60_000
    const secretSchema = z.object({
      keyId: z.string().min(1),
      secret: z.string().regex(/^[a-f0-9]{64}$/),
      createdAt: z.number().int().nonnegative(),
      expiresAt: z.number().int().nonnegative(),
    })
    const record = await this.provider.modifyRecord(this.diagnosticsKey, async current => {
      if (!forceRotate && current?.kind === 'grant') {
        const parsed = secretSchema.safeParse(current.payload)
        if (parsed.success && parsed.data.expiresAt > now) return undefined
      }
      return {
        kind: 'grant',
        payload: {
          keyId: randomUUID(),
          secret: randomBytes(32).toString('hex'),
          createdAt: now,
          expiresAt: now + ttlMs,
        },
      }
    })
    const parsed = secretSchema.safeParse(record?.kind === 'grant' ? record.payload : undefined)
    if (!parsed.success) throw new Error('ChatGPT 诊断密钥记录无效。')
    return {
      keyId: parsed.data.keyId,
      secret: Buffer.from(parsed.data.secret, 'hex'),
      createdAt: parsed.data.createdAt,
      expiresAt: parsed.data.expiresAt,
    }
  }
  private async readAccounts(): Promise<AccountState> { return decode(await this.provider.readRecord(this.key)) }
  private async modify(mutate: (state: AccountState) => void | Promise<void>): Promise<AccountState> {
    return decode(await this.provider.modifyRecord(this.key, async record => {
      const state = decode(record)
      await mutate(state)
      return {kind: 'grant', payload: state}
    }))
  }
  async read(): Promise<StoredState> { return project(await this.readAccounts()) }
  async update(mutate: (state: StoredState) => void | Promise<void>): Promise<StoredState> {
    return project(await this.modify(async accounts => {
      const value = project(accounts)
      await mutate(value)
      const {schemaVersion: _, revision, activeGeneration: _active, accountId: id, ...changed} = value
      accounts.revision = revision
      const selected = accounts.accounts.find(account => account.id === id)
      if (selected) Object.assign(selected, changed)
      else accounts.defaults = changed
    }))
  }
  async snapshot(): Promise<{state: StoredState; accounts: PublicAccount[]}> {
    const state = await this.readAccounts()
    return {state: project(state), accounts: publicAccounts(state)}
  }
  async accounts(): Promise<PublicAccount[]> { return publicAccounts(await this.readAccounts()) }
  async activeAccountId(): Promise<string | undefined> { return (await this.readAccounts()).activeAccountId }
  async switchAccount(id: string): Promise<void> {
    await this.modify(state => {
      if (!state.accounts.some(account => account.id === id)) throw new Error('账号不存在，请刷新列表。')
      if (state.activeAccountId === id) return
      state.activeAccountId = id
      state.revision++
    })
  }
  async connect(value: Credential): Promise<void> {
    const parsed = credential.parse(value)
    await this.modify(state => {
      const id = accountId(parsed)
      let selected = state.accounts.find(account => account.id === id)
      if (!selected) {
        selected = {
          id, ...emptyPreferences(),
          ...(state.defaults.cacheSettings ? {cacheSettings: state.defaults.cacheSettings} : {}),
          grantEpoch: 1, credentialGeneration: 1,
        }
        state.accounts.push(selected)
      } else {
        selected.grantEpoch = (selected.grantEpoch ?? 0) + 1
        selected.credentialGeneration = (selected.credentialGeneration ?? 0) + 1
        delete selected.legacyConnectionId
        delete selected.capabilities
      }
      const {issuer, subject, issuedClientId, hostId, displayEmail} = parsed
      selected.registration = registration.parse({issuer, subject, issuedClientId, hostId, displayEmail})
      selected.credential = parsed
      state.activeAccountId = id
      state.revision++
    })
  }
  async recordUsage(id: string, usage: Usage): Promise<void> {
    await this.modify(state => {
      const selected = state.accounts.find(account => account.id === id)
      if (!selected) return
      for (const key of ['requests', 'inputTokens', 'outputTokens', 'cachedTokens'] as const) selected.usage[key] += usage[key]
      if (usage.cacheWriteTokens !== undefined) {
        selected.usage.cacheWriteTokens = (selected.usage.cacheWriteTokens ?? 0) + usage.cacheWriteTokens
      }
      if (usage.cacheMeasuredInputTokens !== undefined && usage.cacheMeasuredTokens !== undefined) {
        selected.usage.cacheMeasuredInputTokens = (selected.usage.cacheMeasuredInputTokens ?? 0) + usage.cacheMeasuredInputTokens
        selected.usage.cacheMeasuredTokens = (selected.usage.cacheMeasuredTokens ?? 0) + usage.cacheMeasuredTokens
      }
    })
  }
  async setCacheSettings(settings: CacheSettings): Promise<StoredState> {
    const parsed = cacheSettings.parse(settings)
    return this.update(state => {
      state.cacheSettings = parsed
    })
  }
  async recordCapability(id: string, grantEpoch: number, model: string, capability: string, status: CapabilityStatus, projectionVersion = 1, probedAt = Date.now()): Promise<void> {
    await this.modify(state => {
      const selected = state.accounts.find(account => account.id === id)
      if (!selected || (selected.grantEpoch ?? 1) !== grantEpoch) return
      const current = selected.capabilities ?? {}
      const perModel = {...(current[model] ?? {}), [capability]: {status, probedAt, projectionVersion}}
      selected.capabilities = {...current, [model]: perModel}
    })
  }
  async readCapability(id: string, grantEpoch: number, model: string, capability: string): Promise<CapabilityEntry | undefined> {
    const state = await this.readAccounts()
    const selected = state.accounts.find(account => account.id === id)
    if (!selected || (selected.grantEpoch ?? 1) !== grantEpoch) return undefined
    return selected.capabilities?.[model]?.[capability]
  }
  async removeAccount(id: string): Promise<boolean> {
    let revoked = true
    await this.modify(async state => {
      const selected = state.accounts.find(account => account.id === id)
      if (!selected) throw new Error('账号不存在，请刷新列表。')
      if (selected.credential?.refreshToken) {
        try { await this.auth.revoke(selected.credential, AbortSignal.timeout(10_000)) }
        catch { revoked = false }
      }
      selected.credential = undefined
      delete selected.legacyConnectionId
      delete selected.capabilities
      selected.authorizedSessions = []
      selected.allowBackground = true
      if (state.activeAccountId === id) {
        state.activeAccountId = state.accounts.find(account => account.credential)?.id ?? id
        state.revision++
      }
    })
    return revoked
  }
  async returningRegistration(id?: string): Promise<Registration | undefined> {
    if (id === undefined) {
      const state = await this.read()
      return state.credential ?? state.registration
    }
    const selected = (await this.readAccounts()).accounts.find(account => account.id === id)
    if (!selected) throw new Error('账号不存在，请刷新列表。')
    return selected.credential ?? selected.registration
  }
  async connection(signal?: AbortSignal, rejectedAccessToken?: string): Promise<ConnectionValue> {
    signal?.throwIfAborted()
    const current = await this.read()
    signal?.throwIfAborted()
    if (current.credential && usable(current.credential, rejectedAccessToken) &&
      (current.credential.expiresAt > Date.now() + 60_000 || rejectedAccessToken !== undefined) &&
      current.credential.grantedScopes.includes('chatgpt.tokens.use.direct')) {
      return connectionValue(current, this.profileScope)
    }
    return waitForConnection(this.renewConnection(current, rejectedAccessToken), signal)
  }
  private async renewConnection(expected: StoredState, rejectedAccessToken?: string): Promise<ConnectionValue> {
    let failure: unknown
    const state = await this.update(async state => {
      if (state.accountId !== expected.accountId || state.revision !== expected.revision) {
        throw new Error('ChatGPT 连接已变更，请重新发起请求。')
      }
      const value = state.credential
      if (!value) throw new AuthError('invalid_grant', '请先连接 ChatGPT。')
      if (!value.grantedScopes.includes('chatgpt.tokens.use.direct')) {
        throw new AuthError('access_denied', '请在 ChatGPT 中授权此应用使用计划。')
      }
      const rejected = value.accessToken === rejectedAccessToken
      if (!rejected && usable(value) &&
        (value.expiresAt > Date.now() + 60_000 || rejectedAccessToken !== undefined)) return
      if (value.earliestRefreshAt && value.earliestRefreshAt > Date.now()) {
        if (usable(value, rejectedAccessToken)) return
        throw new AuthError('refresh_unavailable', 'ChatGPT 会话尚未到可续期时间，请稍后重试。')
      }
      try {
        const next = credential.parse(await this.auth.refresh(value, AbortSignal.timeout(20_000)))
        const rotated = next.accessToken !== value.accessToken
        state.credential = next
        state.credentialGeneration = (state.credentialGeneration ?? 1) + (rotated ? 1 : 0)
        if (!state.credential.grantedScopes.includes('chatgpt.tokens.use.direct')) {
          failure = new AuthError('access_denied', '请在 ChatGPT 中授权此应用使用计划。')
        }
      } catch (error) {
        const temporary = error instanceof AuthError &&
          (error.code === 'network_error' || error.code === 'service_unavailable')
        if (temporary && usable(value, rejectedAccessToken)) return
        failure = error
        if (error instanceof AuthError && error.code === 'invalid_grant') {
          state.credential = undefined
          delete state.legacyConnectionId
          delete state.capabilities
          state.revision++
        }
      }
    })
    if (failure) throw failure
    return connectionValue(state, this.profileScope)
  }
  async signOut(): Promise<boolean> {
    let revoked = true
    await this.update(async state => {
      if (state.credential?.refreshToken) {
        try { await this.auth.revoke(state.credential, AbortSignal.timeout(10_000)) }
        catch { revoked = false }
      }
      state.credential = undefined
      delete state.legacyConnectionId
      delete state.capabilities
      state.authorizedSessions = []
      state.allowBackground = true
      state.revision++
    })
    return revoked
  }
}
