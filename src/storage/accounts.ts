import { createHash } from 'node:crypto'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { z } from 'zod'

export const registration = z.object({
  issuer: z.literal('https://auth.openai.com'), subject: z.string().min(1),
  issuedClientId: z.string().min(1), hostId: z.string().min(1), displayEmail: z.string().optional(),
})
export const credential = registration.extend({
  schemaVersion: z.literal(1), accessToken: z.string().min(1), refreshToken: z.string().optional(),
  idToken: z.string().min(1), grantedScopes: z.array(z.string()), receivedAt: z.number(),
  expiresAt: z.number(), earliestRefreshAt: z.number().optional(),
})
const usage = z.object({requests: z.number(), inputTokens: z.number(), outputTokens: z.number(), cachedTokens: z.number(),
  cacheWriteTokens: z.number().nonnegative().optional(),
  cacheMeasuredInputTokens: z.number().nonnegative().optional(), cacheMeasuredTokens: z.number().nonnegative().optional()})
export const capabilityStatus = z.enum(['unknown', 'supported', 'unsupported'])
export const capabilityEntry = z.object({
  status: capabilityStatus,
  probedAt: z.number().int().nonnegative(),
  projectionVersion: z.number().int().nonnegative(),
})
export const modelCapabilities = z.record(z.string(), capabilityEntry)
export const cacheSettings = z.object({
  ttl: z.enum(['30m', '12h']).optional(),
  comparisonDiagnostics: z.boolean().optional(),
  configurationUpdate: z.boolean().optional(),
  toolAdditions: z.boolean().optional(),
})
const preferences = z.object({authorizedSessions: z.array(z.string()), allowBackground: z.boolean(), usage,
  contextWindows: z.record(z.string(), z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).default({}),
  grantEpoch: z.number().int().positive().optional(),
  credentialGeneration: z.number().int().positive().optional(),
  legacyConnectionId: z.string().min(1).optional(),
  capabilities: z.record(z.string(), modelCapabilities).optional(),
  cacheSettings: cacheSettings.optional()})
const account = preferences.extend({id: z.string().min(1), registration: registration.optional(), credential: credential.optional()})
const legacy = preferences.extend({schemaVersion: z.literal(1), revision: z.number().int().nonnegative(),
  registration: registration.optional(), credential: credential.optional()})
const schema = z.object({schemaVersion: z.literal(3), revision: z.number().int().nonnegative(),
  activeAccountId: z.string().optional(), accounts: z.array(account), defaults: preferences})
export type Account = z.infer<typeof account>
export type AccountState = z.infer<typeof schema>
export type StoredState = z.infer<typeof legacy> & {accountId?: string; activeGeneration: number}
export type Usage = z.infer<typeof usage>
export type CapabilityStatus = z.infer<typeof capabilityStatus>
export type CapabilityEntry = z.infer<typeof capabilityEntry>
export type CacheSettings = z.infer<typeof cacheSettings>

export function accountId(value: {issuer: string; subject: string; issuedClientId: string}): string {
  return createHash('sha256').update(JSON.stringify([value.issuer, value.subject, value.issuedClientId])).digest('hex')
}
export function emptyPreferences(): z.infer<typeof preferences> {
  return {authorizedSessions: [], allowBackground: true, contextWindows: {},
    usage: {requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0}}
}
export function project(state: AccountState): StoredState {
  const value = state.accounts.find(account => account.id === state.activeAccountId) ?? state.defaults
  const {id: _, ...fields} = {...value, id: state.activeAccountId}
  return {...fields, schemaVersion: 1, revision: state.revision, activeGeneration: state.revision,
    ...(state.activeAccountId ? {accountId: state.activeAccountId} : {})}
}
function ensureAccountGenerations(state: AccountState): AccountState {
  for (const entry of state.accounts) {
    if (!entry.credential) continue
    if (entry.grantEpoch === undefined) {
      entry.grantEpoch = 1
      if (entry.id === state.activeAccountId) {
        entry.legacyConnectionId = `${entry.id}:${state.revision}`
      }
    }
    if (entry.credentialGeneration === undefined) entry.credentialGeneration = 1
  }
  return state
}
export function decode(record: CredentialRecord | undefined): AccountState {
  if (!record) return {schemaVersion: 3, revision: 0, accounts: [], defaults: emptyPreferences()}
  if (record.kind !== 'grant') throw new Error('ChatGPT 凭据记录格式不匹配。')
  const current = z.union([schema, schema.extend({schemaVersion: z.literal(2)})]).safeParse(record.payload)
  if (current.success) {
    const state = current.data
    if ((state.activeAccountId && !state.accounts.some(value => value.id === state.activeAccountId)) ||
      new Set(state.accounts.map(value => value.id)).size !== state.accounts.length) {
      throw new Error('ChatGPT 账号记录格式无效，请重新配置连接。')
    }
    if (state.schemaVersion === 2) {
      state.defaults.allowBackground = true
      for (const account of state.accounts) account.allowBackground = true
    }
    return ensureAccountGenerations({...state, schemaVersion: 3})
  }
  const old = legacy.safeParse(record.payload)
  if (!old.success) throw new Error('ChatGPT 凭据记录格式无效，请重新配置连接。')
  const {schemaVersion: _, revision, ...value} = old.data
  value.allowBackground = true
  const identity = value.credential ?? value.registration
  if (!identity) return {schemaVersion: 3, revision, accounts: [], defaults: value}
  const id = accountId(identity)
  return ensureAccountGenerations({
    schemaVersion: 3, revision, activeAccountId: id,
    accounts: [{id, ...value}], defaults: emptyPreferences(),
  })
}
