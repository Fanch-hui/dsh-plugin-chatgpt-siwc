import type { DiagnosticsFilter, DiagnosticsSnapshot } from '../diagnostics/types.js'
import type { QuotaStatus } from '../quota/service.js'
import type { CacheSettings } from '../storage/state.js'
export type { CacheSettings } from '../storage/state.js'

export interface QuotaLinkSetting { accountId: string; sourceKey: string }

export interface ContextWindowSetting { accountId: string; modelId: string; contextWindow: number | null }

export interface SiwcStatus {
  diagnostics?: DiagnosticsSnapshot
  quota?: QuotaStatus
  accounts: { id: string; email?: string; authenticated: boolean; planEnabled: boolean }[]
  activeAccountId?: string
  authenticated: boolean
  signingIn: boolean
  email?: string
  planEnabled: boolean
  availability: 'ready' | 'unavailable' | 'usage-limited'
  error?: string
  models: { id: string; name: string; verified?: boolean; contextWindow?: number; defaultContextWindow?: number; maxContextWindow?: number; contextWindowOverride?: number }[]
  authorizedSessions: string[]
  allowBackground: boolean
  cacheSettings?: CacheSettings
  usage: { requests: number; inputTokens: number; outputTokens: number; cachedTokens: number;
    cacheWriteTokens?: number; cacheMeasuredInputTokens?: number; cacheMeasuredTokens?: number }
}

export interface SiwcRemote {
  queryDiagnostics(filter: DiagnosticsFilter): Promise<DiagnosticsSnapshot>
  setContextWindow(setting: ContextWindowSetting): Promise<SiwcStatus>
  setCacheSettings(settings: CacheSettings): Promise<SiwcStatus>
  status(): Promise<SiwcStatus>
  linkCodexQuota(setting: QuotaLinkSetting): Promise<SiwcStatus>
  unlinkCodexQuota(accountId: string): Promise<SiwcStatus>
  refreshQuota(): Promise<SiwcStatus>
  connectCodexQuota(): Promise<SiwcStatus>
  cancelCodexQuota(): Promise<SiwcStatus>
  disconnectCodexQuota(): Promise<SiwcStatus>
  addAccount(): Promise<SiwcStatus>
  switchAccount(accountId: string): Promise<SiwcStatus>
  removeAccount(accountId: string): Promise<SiwcStatus>
  reauthorizeAccount(accountId: string): Promise<SiwcStatus>
  beginSignIn(): Promise<SiwcStatus>
  cancelSignIn(): Promise<SiwcStatus>
  signOut(): Promise<SiwcStatus>
  refreshModels(): Promise<SiwcStatus>
  probeModel(modelId: string): Promise<SiwcStatus>
  authorizeSession(sessionId: string): Promise<SiwcStatus>
  revokeSession(sessionId: string): Promise<SiwcStatus>
  setBackgroundAllowed(allowed: boolean): Promise<SiwcStatus>
}
