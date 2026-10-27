import { diagnosticsFilterSchema, diagnosticSnapshotSchema } from './diagnostics/schema.js'
import { z } from 'zod'
import type { InvocationDescriptor, TypertCodec, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry'
import type { SiwcRemote, SiwcStatus } from './api/types.js'

export const REMOTE_PACKAGE = 'dsh-plugin-chatgpt-siwc'
export const REMOTE_NAMESPACE = 'chatgptSiwc'

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const identifier = z.string().min(1).max(512)

const quotaSnapshot = z.strictObject({
  updatedAt: count,
  buckets: z.array(z.strictObject({
    id: identifier, name: z.string().optional(), model: identifier.optional(), planType: z.string().optional(),
    windows: z.array(z.strictObject({usedPercent: z.number().min(0).max(100),
      windowDurationMins: z.number().positive(), resetsAt: count.optional()})),
    credits: z.strictObject({unlimited: z.boolean(), balance: z.string().optional()}).optional(),
  })),
})
const quotaFields = {snapshot: quotaSnapshot.optional(), error: z.string().optional()}
const codexQuotaFields = {...quotaFields, state: z.enum(['disconnected', 'connecting', 'ready', 'unavailable']),
  email: z.string().optional(), planType: z.string().optional(), sourceKey: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  persistentLink: z.boolean().optional(), linkedToCurrent: z.boolean().optional()}
const quotaSchema = z.strictObject({
  codex: z.strictObject({...codexQuotaFields, id: identifier.optional()}),
  accounts: z.array(z.strictObject({...codexQuotaFields, id: identifier})).max(128).optional(),
  selectedAccountId: identifier.optional(),
  current: z.strictObject({...quotaFields, state: z.enum(['ready', 'unavailable']),
    source: z.literal('linked-codex')}).optional(),
})

const cacheSettingsSchema = z.strictObject({
  ttl: z.enum(['30m', '12h']).optional(),
  comparisonDiagnostics: z.boolean().optional(),
  configurationUpdate: z.boolean().optional(),
  toolAdditions: z.boolean().optional(),
})

/** The Remote result admits only the Host's public connection projection. */
export const statusSchema: z.ZodType<SiwcStatus> = z.strictObject({
  accounts: z.array(z.strictObject({ id: identifier, email: z.string().optional(), authenticated: z.boolean(), planEnabled: z.boolean() })),
  activeAccountId: identifier.optional(),
  quota: quotaSchema.optional(),
  diagnostics: diagnosticSnapshotSchema.optional(),
  authenticated: z.boolean(),
  signingIn: z.boolean(),
  email: z.string().optional(),
  planEnabled: z.boolean(),
  availability: z.enum(['ready', 'unavailable', 'usage-limited']),
  error: z.string().optional(),
  models: z.array(z.strictObject({
    id: identifier,
    name: z.string(),
    verified: z.boolean().optional(),
    contextWindow: count.positive().optional(),
    defaultContextWindow: count.positive().optional(),
    maxContextWindow: count.positive().optional(),
    contextWindowOverride: count.positive().optional(),
  })),
  authorizedSessions: z.array(identifier),
  allowBackground: z.boolean(),
  cacheSettings: cacheSettingsSchema.optional(),
  usage: z.strictObject({
    requests: count,
    inputTokens: count,
    outputTokens: count,
    cachedTokens: count,
    cacheWriteTokens: count.optional(),
    cacheMeasuredInputTokens: count.optional(),
    cacheMeasuredTokens: count.optional(),
  }),
})

function codec<Value>(typeSymbol: string, schema: z.ZodType<Value>): TypertCodec<Value> {
  return { mode: 'strict', typeSymbol, create: () => schema }
}

function method(
  name: keyof SiwcRemote,
  parameter?: { name: string; codec: TypertCodec },
  result: TypertCodec = codec('SiwcStatus', statusSchema),
): InvocationDescriptor {
  return {
    id: `${REMOTE_PACKAGE}#${REMOTE_NAMESPACE}/${name}`,
    service: REMOTE_NAMESPACE,
    namespace: REMOTE_NAMESPACE,
    method: name,
    invocation: { kind: 'direct' },
    parameters: parameter === undefined ? [] : [{
      name: parameter.name,
      wire: parameter.name,
      source: 'json',
      codec: parameter.codec,
    }],
    result,
  }
}

/** Both carriers use these exact descriptors and boundary parsers. */
const descriptors: readonly InvocationDescriptor[] = [
  method('status'),
  method('queryDiagnostics', {name: 'filter', codec: codec('DiagnosticsFilter', diagnosticsFilterSchema)},
    codec('DiagnosticsSnapshot', diagnosticSnapshotSchema)),
  method('setContextWindow', {name: 'setting', codec: codec('ContextWindowSetting', z.strictObject({
    accountId: identifier, modelId: identifier, contextWindow: count.positive().nullable(),
  }))}),
  method('setCacheSettings', {name: 'settings', codec: codec('CacheSettings', cacheSettingsSchema)}),
  method('linkCodexQuota', {name: 'setting', codec: codec('QuotaLinkSetting', z.strictObject({accountId: identifier, sourceKey: z.string().regex(/^[a-f0-9]{64}$/)}))}),
  method('unlinkCodexQuota', {name: 'accountId', codec: codec('string', identifier)}),
  method('refreshQuota'),
  method('connectCodexQuota'),
  method('cancelCodexQuota'),
  method('disconnectCodexQuota'),
  method('addCodexQuota'),
  method('selectCodexQuota', {name: 'id', codec: codec('string', identifier)}),
  method('removeCodexQuota', {name: 'id', codec: codec('string', identifier)}),
  method('beginSignIn'),
  method('addAccount'),
  method('switchAccount', { name: 'accountId', codec: codec('string', identifier) }),
  method('removeAccount', { name: 'accountId', codec: codec('string', identifier) }),
  method('reauthorizeAccount', { name: 'accountId', codec: codec('string', identifier) }),
  method('cancelSignIn'),
  method('signOut'),
  method('refreshModels'),
  method('probeModel', { name: 'modelId', codec: codec('string', identifier) }),
  method('authorizeSession', { name: 'sessionId', codec: codec('string', identifier) }),
  method('revokeSession', { name: 'sessionId', codec: codec('string', identifier) }),
  method('setBackgroundAllowed', { name: 'allowed', codec: codec('boolean', z.boolean()) }),
]

export const remoteContribution: TypertRemoteContribution = {
  package: REMOTE_PACKAGE,
  descriptors,
}

export const contribution = remoteContribution

export const TYPERT: TypertContribution = {
  package: REMOTE_PACKAGE,
  face: 'host',
  schemas: [
    { name: 'SiwcStatus', create: () => statusSchema },
    { name: 'DiagnosticsSnapshot', create: () => diagnosticSnapshotSchema },
  ],
  model: { services: [], events: [], objects: [] },
  invocations: descriptors,
}
