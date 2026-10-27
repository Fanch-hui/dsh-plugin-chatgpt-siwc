import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import {
  CredentialProvider,
  type CredentialKey,
  type CredentialRecord,
  type CredentialRef,
} from '@deepseek-ai/dsh-credentials'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { SessionStore } from '@deepseek-ai/dsh-session'
import ChatGPTSiwc from '../src/index.js'
import { REMOTE_NAMESPACE, REMOTE_PACKAGE, statusSchema, TYPERT } from '../src/remote.js'
import { diagnosticSnapshotSchema } from '../src/diagnostics/schema.js'
import type { RequestDiagnostic } from '../src/diagnostics/types.js'

/** The Host fixture persists synthetic grants through their JSON boundary. */
class MemoryCredentials extends CredentialProvider {
  private readonly records = new Map<CredentialKey, string>()
  private readonly references = new Map<CredentialRef, string>()
  private transaction: Promise<unknown> = Promise.resolve()

  constructor(ctx: Context) { super(ctx) }
  async resolve(ref: CredentialRef) {
    const value = this.references.get(ref)
    return value === undefined ? undefined : { value, source: 'memory' }
  }
  async describe(ref: CredentialRef) {
    return { configured: this.references.has(ref), writable: true }
  }
  async set(ref: CredentialRef, value: string) { this.references.set(ref, value) }
  async unset(ref: CredentialRef) { this.references.delete(ref) }
  async readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    const json = this.records.get(key)
    return json === undefined ? undefined : JSON.parse(json) as CredentialRecord
  }
  async describeRecord(key: CredentialKey) {
    const record = await this.readRecord(key)
    return { configured: record !== undefined, writable: true, kind: record?.kind }
  }
  async listRecords() {
    return Promise.all([...this.records.keys()].map(async key => ({
      key, kind: (await this.readRecord(key))!.kind,
    })))
  }
  modifyRecord(key: CredentialKey,
    mutate: (record: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const pending = this.transaction.then(async () => {
      const next = await mutate(await this.readRecord(key))
      if (next !== undefined) this.records.set(key, JSON.stringify(next))
      return this.readRecord(key)
    })
    this.transaction = pending.catch(() => {})
    return pending
  }
  async deleteRecord(key: CredentialKey) { this.records.delete(key) }
}

async function host(profileDir = '/fixture/dsh/profiles/host-fixture'): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials)
  ctx.provide('profileContext', {
    name: 'host-fixture', dir: profileDir,
    patchPath: join(profileDir, 'cordis.patch.yml'),
    installAnchor: '/fixture/dsh', cwd: '/fixture/workspace', home: '/fixture/dsh',
    startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
  })
  ctx.provide('sessions', {
    get: () => undefined,
  } as unknown as SessionStore)
  ctx.provide('attachments', {
    async readImage() { throw new Error('This Host fixture has no images') },
  } as unknown as AttachmentStore)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccessService)
  await ctx.plugin(TypertGatewayService)
  return ctx
}

test('real Cordis Host registers strict Remote methods and releases routing on disposal', async () => {
  const ctx = await host()
  const peer = new Peer(ctx, { principal: { kind: 'owner' } })
  const invoke = (method: string, args: Record<string, unknown> = {}) =>
    ctx.typertGateway.invoke({ namespace: REMOTE_NAMESPACE, method, args, peer })
  try {
    const plugin = ctx.plugin(ChatGPTSiwc)
    await plugin
    assert.ok(ctx.get('chatgptSiwc'))
    assert.deepEqual(ctx.llm.listProviders().map(provider => provider.id), ['chatgpt-siwc'])
    assert.deepEqual(ctx.typert.getPackage(REMOTE_PACKAGE, 'host')?.model,
      { services: [], events: [], objects: [] })
    assert.equal(ctx.typert.local.list().filter(item => item.namespace === REMOTE_NAMESPACE).length, 22)
    const descriptor = ctx.typert.local.get(`${REMOTE_NAMESPACE}/status`)
    assert.equal(descriptor?.service, REMOTE_NAMESPACE)
    assert.equal(descriptor?.result.mode, 'strict')
    const initial = statusSchema.parse(await invoke('status'))
    assert.equal(initial.authenticated, false)
    assert.equal(initial.planEnabled, false)
    assert.deepEqual(initial.models, [])
    assert.equal(initial.allowBackground, true)

    await assert.rejects(invoke('status', { accessToken: 'fixture-unknown-field' }))
    await assert.rejects(invoke('setBackgroundAllowed', { allowed: 'true' }))
    assert.equal(statusSchema.parse(await invoke('status')).allowBackground, true)
    assert.equal(statusSchema.parse(await invoke('setBackgroundAllowed', { allowed: true })).allowBackground, true)
    assert.deepEqual(statusSchema.parse(await invoke('setCacheSettings', { settings: { ttl: '30m', comparisonDiagnostics: true } })).cacheSettings,
      { ttl: '30m', comparisonDiagnostics: true })

    await plugin.dispose()
    assert.equal(ctx.get('chatgptSiwc'), undefined)
    assert.deepEqual(ctx.llm.listProviders(), [])
    assert.equal(ctx.typert.local.get(`${REMOTE_NAMESPACE}/status`), undefined)
    assert.equal(ctx.typert.getPackage(REMOTE_PACKAGE, 'host'), undefined)
    await assert.rejects(invoke('status'))

    const restarted = ctx.plugin(ChatGPTSiwc)
    await restarted
    assert.equal(statusSchema.parse(await invoke('status')).allowBackground, true)
    assert.equal(ctx.typert.local.list().filter(item => item.namespace === REMOTE_NAMESPACE).length,
      TYPERT.invocations.length)
    await restarted.dispose()
    assert.deepEqual(ctx.llm.listProviders(), [])
  } finally {
    await peer.dispose()
    await ctx.fiber.dispose()
  }
})

test('real Host diagnostics queries filter all retained records through the strict Remote gateway', async t => {
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-siwc-host-diagnostics-'))
  t.after(() => rm(profileDir, {recursive: true, force: true}))
  const base: RequestDiagnostic = {
    id: 'query-base', startedAt: 1000, durationMs: 5, accountKey: 'a'.repeat(64),
    model: 'fixture-query-model', category: 'conversation', outcome: 'completed', sent: true,
    inputTokens: 100, cachedTokens: 60, cacheWriteTokens: 10, outputTokens: 2,
    transport: [{mode: 'ws-incremental', reason: 'continued'}],
  }
  const matching = Array.from({length: 45}, (_, index): RequestDiagnostic => ({
    ...base, id: `query-match-${index}`, startedAt: 1000 + index,
  }))
  const records: RequestDiagnostic[] = [
    ...matching,
    {...base, id: 'query-other-category', startedAt: 1045, category: 'subagent'},
    {...base, id: 'query-other-model', startedAt: 900, model: 'fixture-other-model'},
    {...base, id: 'query-other-reason', startedAt: 1046,
      transport: [{mode: 'ws-full', reason: 'cold-connection'}]},
  ]
  await writeFile(join(profileDir, 'chatgpt-siwc-diagnostics.json'), JSON.stringify({version: 1, records}))
  const ctx = await host(profileDir)
  const peer = new Peer(ctx, {principal: {kind: 'owner'}})
  const invoke = (method: string, args: Record<string, unknown> = {}) =>
    ctx.typertGateway.invoke({namespace: REMOTE_NAMESPACE, method, args, peer})
  try {
    await ctx.plugin(ChatGPTSiwc)
    const descriptor = ctx.typert.local.get(`${REMOTE_NAMESPACE}/queryDiagnostics`)
    assert.equal(descriptor?.result.mode, 'strict')
    assert.equal(descriptor?.result.typeSymbol, 'DiagnosticsSnapshot')

    const status = statusSchema.parse(await invoke('status'))
    const summary = status.diagnostics
    assert.ok(summary)
    assert.equal(summary.retained, 48)
    assert.equal(summary.records, undefined)
    assert.equal(summary.recent.length, 30)
    assert.equal(summary.recent.some(record => record.id === 'query-match-0'), false)
    assert.equal(summary.recent.some(record => record.model === 'fixture-other-model'), false)
    assert.deepEqual(summary.models, ['fixture-other-model', 'fixture-query-model'])
    assert.equal(summary.groups.reduce((sum, group) => sum + group.requests, 0), 48)
    assert.equal(summary.metrics?.totalInputTokens, 4800)
    assert.equal(summary.metrics?.cachedTokens, 2880)

    const filtered = diagnosticSnapshotSchema.parse(await invoke('queryDiagnostics', {
      filter: {category: 'conversation', model: 'fixture-query-model', reason: 'continued'},
    }))
    assert.equal(filtered.retained, 45)
    assert.equal(filtered.since, 1000)
    assert.deepEqual(filtered.records, [...matching].reverse())
    assert.deepEqual(filtered.recent, matching.slice(-30).reverse())
    assert.deepEqual(filtered.models, ['fixture-query-model'])
    assert.deepEqual(filtered.groups, [{category: 'conversation', requests: 45, measuredRequests: 45,
      failed: 0, inputTokens: 4500, cachedTokens: 2700, cacheWriteTokens: 450, outputTokens: 90, durationMs: 225}])
    assert.deepEqual(filtered.reasons, [{reason: 'continued', requests: 45}])
    assert.deepEqual(filtered.metrics, {cacheReadRate: 0.6, meteringCoverageRate: 1,
      totalInputTokens: 4500, cachedTokens: 2700, cacheWriteTokens: 450, otherInputTokens: 1350, missingCacheSamples: 0})

    const all = diagnosticSnapshotSchema.parse(await invoke('queryDiagnostics', {filter: {}}))
    assert.equal(all.records?.length, 48)
    assert.equal(all.records?.at(-1)?.id, 'query-other-model')
    assert.deepEqual(all.recent, summary.recent)
    assert.deepEqual(all.groups, summary.groups)
    assert.deepEqual(all.metrics, summary.metrics)
    assert.deepEqual(all.models, summary.models)

    await assert.rejects(invoke('queryDiagnostics', {filter: {
      category: 'conversation', model: 'fixture-query-model', reason: 'continued',
      unknownFilter: 'fixture-unknown-field',
    }}))
  } finally {
    await peer.dispose()
    await ctx.fiber.dispose()
  }
})
