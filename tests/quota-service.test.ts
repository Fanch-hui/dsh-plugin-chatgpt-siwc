import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CredentialKey, CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { Credential } from '../src/auth/index.js'
import { ConnectionStore } from '../src/storage/state.js'
import { QuotaLinks } from '../src/quota/links.js'
import { QuotaService } from '../src/quota/service.js'

class MemoryCredentials implements Pick<CredentialProvider, 'readRecord' | 'modifyRecord'> {
  private records = new Map<CredentialKey, string>()
  private transaction: Promise<unknown> = Promise.resolve()
  async readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    const value = this.records.get(key)
    return value === undefined ? undefined : JSON.parse(value)
  }
  modifyRecord(key: CredentialKey, mutate: (record: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) {
    const pending = this.transaction.then(async () => {
      const value = await mutate(await this.readRecord(key))
      if (value !== undefined) this.records.set(key, JSON.stringify(value))
      return this.readRecord(key)
    })
    this.transaction = pending.catch(() => {})
    return pending
  }
}
function credential(name: string): Credential {
  return {schemaVersion: 1, issuer: 'https://auth.openai.com', subject: `fixture-subject-${name}`,
    issuedClientId: `fixture-client-${name}`, hostId: 'fixture-host', displayEmail: `${name}@example.invalid`,
    accessToken: `fixture-access-${name}`, refreshToken: `fixture-refresh-${name}`, idToken: `fixture-id-${name}`,
    grantedScopes: ['chatgpt.tokens.use.direct'], receivedAt: Date.now(), expiresAt: Date.now() + 3_600_000}
}
const rpcQuota = {accountId: 'fixture-source-account', rateLimitsByLimitId: {codex: {limitId: 'codex', planType: 'pro',
  primary: {usedPercent: 37, windowDurationMins: 10_080, resetsAt: 1_900_000_000}}}}
class FixtureRpc {
  readonly calls: {method: string; params?: unknown}[] = []
  readonly listeners = new Set<(method: string, params: unknown) => void>()
  account: unknown = null
  quota: unknown = rpcQuota
  closed = false
  onLogin?: () => void
  async request(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({method, params})
    if (method === 'account/read') return {account: this.account}
    if (method === 'account/rateLimits/read') {
      if (this.quota instanceof Error) throw this.quota
      return this.quota
    }
    if (method === 'account/login/start') {
      this.onLogin?.()
      return {loginId: 'fixture-login', authUrl: 'https://auth.openai.com/oauth/authorize?fixture=1'}
    }
    if (method === 'account/login/cancel') return {}
    if (method === 'account/logout') { this.account = null; return {} }
    throw new Error('Unexpected fixture method')
  }
  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  emit(params: unknown) { for (const listener of this.listeners) listener('account/login/completed', params) }
  async close(): Promise<void> { this.closed = true }
}
function gate<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return {promise, resolve}
}
async function fixture(signedIn = true) {
  const profile = await mkdtemp(join(tmpdir(), 'dsh-quota-service-'))
  const store = new ConnectionStore(new MemoryCredentials(), profile, {async refresh(value) { return value }, async revoke() {}})
  if (signedIn) await store.connect(credential('a'))
  const id = await store.activeAccountId()
  const rpc = new FixtureRpc()
  const browser: string[] = []
  const dependencies = {
    start: async (home: string) => { assert.equal(home, join(profile, 'chatgpt-siwc-codex-quota')); return rpc },
    browser: async (url: string) => { browser.push(url) },
  }
  const service = new QuotaService(store, profile, dependencies)
  return {store, id, rpc, service, browser, profile, dependencies,
    async close() { await service.dispose(); await rm(profile, {recursive: true, force: true}) }}
}
async function settled(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('Fixture operation did not settle')
}

test('Codex quota exposes its own projected account until explicitly linked', async () => {
  const value = await fixture()
  try {
    value.rpc.account = {type: 'chatgpt', email: 'a@example.invalid', planType: 'pro', privateValue: 'fixture-private'}
    await value.service.connectCodex()
    const status = value.service.status(value.id)
    assert.equal(status.current, undefined)
    assert.equal(status.codex.linkedToCurrent, false)
    assert.equal(status.codex.state, 'ready')
    assert.equal(status.codex.persistentLink, true)
    assert.match(status.codex.sourceKey!, /^[a-f0-9]{64}$/)
    assert.deepEqual(status.codex.snapshot?.buckets[0].windows,
      [{usedPercent: 37, windowDurationMins: 10_080, resetsAt: 1_900_000_000}])
    assert.doesNotMatch(JSON.stringify(status), /fixture-(private|source-account|access|refresh)/)
    assert.equal(value.browser.length, 0)
  } finally { await value.close() }
})

test('explicit quota associations are scoped to the selected chat account and can be unlinked', async () => {
  const value = await fixture()
  try {
    value.rpc.account = {type: 'chatgpt', email: 'codex@example.invalid', planType: 'pro'}
    await value.service.connectCodex()
    const source = value.service.status().codex.sourceKey!
    await value.service.linkCodex(value.id!, source)
    assert.equal(value.service.status(value.id).current?.source, 'linked-codex')
    assert.equal(value.service.status(value.id).current?.state, 'ready')
    await value.store.connect(credential('b'))
    const other = await value.store.activeAccountId()
    assert.equal(value.service.status(other).current, undefined)
    await assert.rejects(value.service.linkCodex(value.id!, source), /聊天账号已变化/)
    await value.service.linkCodex(other!, source)
    await value.service.clear(value.id!)
    assert.equal(value.service.status(value.id).current, undefined)
    assert.equal(value.service.status(other).current?.state, 'ready')
    await value.service.unlinkCodex(other!)
    assert.equal(value.service.status(other).current, undefined)
  } finally { await value.close() }
})

for (const persistent of [true, false]) {
  test(`${persistent ? 'stable' : 'runtime'} quota identities preserve only eligible associations across restart`, async () => {
    const value = await fixture()
    let restarted: QuotaService | undefined
    try {
      value.rpc.account = {type: 'chatgpt', email: 'codex@example.invalid', planType: 'pro'}
      if (!persistent) value.rpc.quota = {rateLimitsByLimitId: rpcQuota.rateLimitsByLimitId}
      await value.service.connectCodex()
      await value.service.linkCodex(value.id!, value.service.status().codex.sourceKey!)
      assert.equal(value.service.status(value.id).current?.state, 'ready')
      await value.service.dispose()
      const rpc = new FixtureRpc()
      rpc.account = value.rpc.account
      rpc.quota = value.rpc.quota
      restarted = new QuotaService(value.store, value.profile, {...value.dependencies, start: async () => rpc})
      await restarted.connectCodex()
      assert.equal(restarted.status(value.id).codex.linkedToCurrent, persistent)
      assert.equal(Boolean(restarted.status(value.id).current), persistent)
    } finally { await restarted?.dispose(); await value.close() }
  })
}

test('quota source changes invalidate old associations even when the email stays the same', async () => {
  const value = await fixture()
  try {
    value.rpc.account = {type: 'chatgpt', email: 'codex@example.invalid', planType: 'pro'}
    await value.service.connectCodex()
    const source = value.service.status().codex.sourceKey!
    await value.service.linkCodex(value.id!, source)
    value.rpc.quota = {...rpcQuota, accountId: 'fixture-different-workspace'}
    await value.service.refresh()
    assert.notEqual(value.service.status().codex.sourceKey, source)
    assert.equal(value.service.status(value.id).current, undefined)
    await assert.rejects(value.service.linkCodex(value.id!, source), /额度连接已变化/)
    value.rpc.quota = rpcQuota
    await value.service.refresh()
    assert.equal(value.service.status(value.id).current, undefined)
  } finally { await value.close() }
})

test('quota logout invalidates the association and reconnect requires a new confirmation', async () => {
  const value = await fixture()
  try {
    value.rpc.account = {type: 'chatgpt', email: 'codex@example.invalid'}
    await value.service.connectCodex()
    await value.service.linkCodex(value.id!, value.service.status().codex.sourceKey!)
    value.rpc.account = null
    await value.service.refresh()
    assert.equal(value.service.status(value.id).codex.state, 'disconnected')
    assert.equal(value.service.status(value.id).current, undefined)
    value.rpc.account = {type: 'chatgpt', email: 'codex@example.invalid'}
    await value.service.connectCodex()
    assert.equal(value.service.status(value.id).current, undefined)
    await value.service.linkCodex(value.id!, value.service.status().codex.sourceKey!)
    await value.service.disconnectCodex()
    assert.equal(value.service.status(value.id).current, undefined)
    assert.ok(value.rpc.calls.some(call => call.method === 'account/logout'))
  } finally { await value.close() }
})

test('temporary quota and RPC restart failures retain the associated snapshot', async () => {
  const value = await fixture()
  try {
    value.rpc.account = {type: 'chatgpt', email: 'codex@example.invalid', planType: 'pro'}
    await value.service.connectCodex()
    await value.service.linkCodex(value.id!, value.service.status().codex.sourceKey!)
    const before = value.service.status(value.id).current?.snapshot
    value.rpc.quota = new Error('fixture-private-rpc-error')
    await value.service.refresh()
    const status = value.service.status(value.id)
    assert.equal(status.current?.state, 'unavailable')
    assert.deepEqual(status.current?.snapshot, before)
    assert.match(status.current?.error!, /读取失败/)
    assert.doesNotMatch(JSON.stringify(status), /fixture-private-rpc-error/)
    assert.equal(value.rpc.closed, true)
    const home = join(value.profile, 'chatgpt-siwc-codex-quota')
    await mkdir(home, {recursive: true})
    await writeFile(join(home, 'auth.json'), '{}')
    value.dependencies.start = async () => { throw new Error('fixture-restart-failure') }
    await value.service.refresh()
    const failedRestart = value.service.status(value.id)
    assert.deepEqual(failedRestart.current?.snapshot, before)
    assert.equal(failedRestart.current?.state, 'unavailable')
    assert.match(failedRestart.current?.error!, /无法启动/)
    assert.doesNotMatch(JSON.stringify(failedRestart), /fixture-restart-failure/)
  } finally { await value.close() }
})

test('email changes do not invalidate a source while its stable identity is unavailable', async () => {
  const value = await fixture()
  try {
    value.rpc.account = {type: 'chatgpt', email: 'first@example.invalid'}
    await value.service.connectCodex()
    const source = value.service.status().codex.sourceKey!
    await value.service.linkCodex(value.id!, source)
    const snapshot = value.service.status(value.id).current?.snapshot
    value.rpc.account = {type: 'chatgpt', email: 'second@example.invalid'}
    value.rpc.quota = new Error('fixture-rpc-error')
    await value.service.refresh()
    const status = value.service.status(value.id)
    assert.equal(status.codex.state, 'unavailable')
    assert.deepEqual(status.current?.snapshot, snapshot)
    assert.equal(status.current?.state, 'unavailable')
    value.rpc.quota = rpcQuota
    await value.service.connectCodex()
    assert.equal(value.service.status().codex.sourceKey, source)
    assert.equal(value.service.status(value.id).current?.state, 'ready')
    value.rpc.quota = {...rpcQuota, accountId: 'fixture-source-new'}
    await value.service.refresh()
    assert.equal(value.service.status(value.id).current, undefined)
  } finally { await value.close() }
})

test('Codex browser login settles the matching attempt and cancellation ignores late results', async () => {
  const value = await fixture(false)
  try {
    await value.service.connectCodex()
    assert.equal(value.service.status().codex.state, 'connecting')
    assert.equal(value.browser.length, 1)
    value.rpc.emit({loginId: 'unrelated-login', success: true})
    assert.equal(value.service.status().codex.state, 'connecting')
    value.rpc.account = {type: 'chatgpt', email: 'codex@example.invalid', planType: 'plus'}
    value.rpc.emit({loginId: 'fixture-login', success: true})
    await settled(() => value.service.status().codex.state === 'ready')
    await value.service.disconnectCodex()
    await value.service.connectCodex()
    await value.service.cancelCodex()
    assert.deepEqual(value.rpc.calls.at(-1), {method: 'account/login/cancel', params: {loginId: 'fixture-login'}})
    value.rpc.emit({loginId: 'fixture-login', success: true})
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(value.service.status().codex.state, 'disconnected')
  } finally { await value.close() }
})

test('Codex completion arriving before the start response still settles the login', async () => {
  const value = await fixture(false)
  try {
    value.rpc.onLogin = () => {
      value.rpc.account = {type: 'chatgpt', email: 'codex@example.invalid', planType: 'plus'}
      value.rpc.emit({loginId: 'fixture-login', success: true})
    }
    await value.service.connectCodex()
    await settled(() => value.service.status().codex.state === 'ready')
    assert.equal(value.browser.length, 0)
  } finally { await value.close() }
})

test('cancelling a quota read discards its late response', async () => {
  const value = await fixture()
  try {
    value.rpc.account = {type: 'chatgpt', email: 'codex@example.invalid'}
    await value.service.connectCodex()
    const entered = gate<void>()
    const result = gate<unknown>()
    const original = value.rpc.request.bind(value.rpc)
    value.rpc.request = async (method, params) => {
      if (method === 'account/rateLimits/read') { entered.resolve(); return result.promise }
      return original(method, params)
    }
    const reading = value.service.refresh()
    await entered.promise
    await value.service.cancelCodex()
    result.resolve(rpcQuota)
    await reading
    assert.equal(value.service.status(value.id).codex.state, 'disconnected')
    assert.equal(value.service.status(value.id).current, undefined)
  } finally { await value.close() }
})

test('disposing closes the quota RPC client and discards an in-flight result', async () => {
  const value = await fixture()
  try {
    value.rpc.account = {type: 'chatgpt', email: 'codex@example.invalid'}
    await value.service.connectCodex()
    const entered = gate<void>()
    const result = gate<unknown>()
    const original = value.rpc.request.bind(value.rpc)
    value.rpc.request = async (method, params) => {
      if (method === 'account/rateLimits/read') { entered.resolve(); return result.promise }
      return original(method, params)
    }
    const reading = value.service.refresh()
    await entered.promise
    const disposing = value.service.dispose()
    result.resolve(rpcQuota)
    await Promise.all([reading, disposing])
    assert.equal(value.rpc.closed, true)
  } finally { await value.close() }
})


test('an account switch during association persistence discards the pending association', async t => {
  const value = await fixture()
  const entered = gate<void>()
  const resume = gate<void>()
  const original = QuotaLinks.prototype.bind
  t.mock.method(QuotaLinks.prototype, 'bind', async function(this: QuotaLinks, ...args: Parameters<QuotaLinks['bind']>) {
    entered.resolve()
    await resume.promise
    return original.apply(this, args)
  })
  try {
    value.rpc.account = {type: 'chatgpt', email: 'codex@example.invalid'}
    await value.service.connectCodex()
    const linking = value.service.linkCodex(value.id!, value.service.status().codex.sourceKey!)
    await entered.promise
    await value.store.connect(credential('b'))
    resume.resolve()
    await assert.rejects(linking, /账号或额度连接已变化/)
    assert.equal(value.service.status(value.id).current, undefined)
    assert.equal(value.service.status(await value.store.activeAccountId()).current, undefined)
  } finally { resume.resolve(); await value.close() }
})


for (const action of ['disconnect', 'reconnect'] as const) {
  test(`a delayed failed-client close cannot overwrite a newer ${action} result`, async t => {
    const value = await fixture()
    const closing = gate<void>()
    const resume = gate<void>()
    const replacement = new FixtureRpc()
    const originalClose = value.rpc.close.bind(value.rpc)
    try {
      value.rpc.account = {type: 'chatgpt', email: 'first@example.invalid'}
      await value.service.connectCodex()
      await value.service.linkCodex(value.id!, value.service.status().codex.sourceKey!)
      value.rpc.quota = new Error('fixture-query-failure')
      t.mock.method(value.rpc, 'close', async () => {
        closing.resolve()
        await resume.promise
        await originalClose()
      })
      value.dependencies.start = async () => replacement
      const reading = value.service.refresh()
      await closing.promise
      await value.service.disconnectCodex()
      if (action === 'reconnect') {
        replacement.account = {type: 'chatgpt', email: 'second@example.invalid'}
        replacement.quota = {...rpcQuota, accountId: 'fixture-new-source'}
        await value.service.connectCodex()
        await value.service.linkCodex(value.id!, value.service.status().codex.sourceKey!)
      }
      const current = value.service.status(value.id)
      resume.resolve()
      await reading
      assert.deepEqual(value.service.status(value.id), current)
      assert.equal(current.codex.state, action === 'reconnect' ? 'ready' : 'disconnected')
    } finally { resume.resolve(); await value.close() }
  })
}

async function multipleAccounts() {
  const profile = await mkdtemp(join(tmpdir(), 'dsh-quota-multiple-'))
  const store = new ConnectionStore(new MemoryCredentials(), profile, {async refresh(value) { return value }, async revoke() {}})
  await store.connect(credential('a'))
  const accountA = (await store.activeAccountId())!
  const first = new FixtureRpc()
  first.account = {type: 'chatgpt', email: 'first@example.invalid'}
  first.quota = {...rpcQuota, accountId: 'fixture-source-a'}
  const second = new FixtureRpc()
  second.quota = {accountId: 'fixture-source-b', rateLimitsByLimitId: {codex: {limitId: 'codex',
    primary: {usedPercent: 81, windowDurationMins: 300}}}}
  const homes: string[] = []
  const clients = new Map<string, FixtureRpc>()
  const legacy = join(profile, 'chatgpt-siwc-codex-quota')
  const dependencies = {
    async start(home: string) {
      homes.push(home)
      if (home === legacy) return first
      clients.set(home, second)
      return second
    },
    async browser(_url: string) {},
  }
  const service = new QuotaService(store, profile, dependencies)
  return {profile, store, service, accountA, first, second, clients, homes, legacy, dependencies,
    async close() { await service.dispose(); await rm(profile, {recursive: true, force: true}) }}
}

async function readySecond(value: Awaited<ReturnType<typeof multipleAccounts>>) {
  await value.service.addCodex()
  assert.equal(value.service.status().codex.state, 'connecting')
  const secondId = value.service.status().selectedAccountId!
  value.second.account = {type: 'chatgpt', email: 'second@example.invalid'}
  value.second.emit({loginId: 'fixture-login', success: true})
  await settled(() => value.service.status().codex.state === 'ready')
  return secondId
}

function usedPercent(value: ReturnType<QuotaService['status']>): number | undefined {
  return value.current?.snapshot?.buckets[0]?.windows[0]?.usedPercent
}

test('separate quota logins follow each chat account and retain stable associations after restart', async () => {
  const value = await multipleAccounts()
  let restarted: QuotaService | undefined
  try {
    await value.service.connectCodex()
    const firstId = value.service.status().selectedAccountId!
    await value.service.linkCodex(value.accountA, value.service.status().codex.sourceKey!)
    await value.store.connect(credential('b'))
    const accountB = (await value.store.activeAccountId())!
    const secondId = await readySecond(value)
    assert.notEqual(firstId, secondId)
    await value.service.linkCodex(accountB, value.service.status().codex.sourceKey!)
    assert.equal(usedPercent(value.service.status(value.accountA)), 37)
    assert.equal(usedPercent(value.service.status(accountB)), 81)
    assert.equal(value.service.status(value.accountA).accounts?.find(account => account.id === firstId)?.linkedToCurrent, true)
    assert.equal(value.service.status(accountB).accounts?.find(account => account.id === secondId)?.linkedToCurrent, true)
    const secondHome = [...value.clients.keys()][0]
    assert.equal(secondHome, join(value.profile, 'chatgpt-siwc-codex-quota-accounts', secondId))
    for (const home of [value.legacy, secondHome]) {
      await mkdir(home, {recursive: true})
      await writeFile(join(home, 'auth.json'), '{}')
    }
    await value.service.dispose()
    const first = new FixtureRpc()
    first.account = value.first.account
    first.quota = value.first.quota
    const second = new FixtureRpc()
    second.account = value.second.account
    second.quota = value.second.quota
    restarted = new QuotaService(value.store, value.profile, {
      async start(home) { return home === value.legacy ? first : second }, async browser() {},
    })
    await restarted.refresh()
    assert.equal(restarted.status().accounts?.length, 2)
    assert.equal(usedPercent(restarted.status(value.accountA)), 37)
    assert.equal(usedPercent(restarted.status(accountB)), 81)
    await restarted.selectCodex(firstId)
    assert.equal(usedPercent(restarted.status(accountB)), 81)
  } finally { await restarted?.dispose(); await value.close() }
})

test('a quota login in progress does not prevent another bound source from refreshing', async () => {
  const value = await multipleAccounts()
  try {
    await value.service.connectCodex()
    await value.service.linkCodex(value.accountA, value.service.status().codex.sourceKey!)
    await value.service.addCodex()
    assert.equal(value.service.status().codex.state, 'connecting')
    value.first.quota = {accountId: 'fixture-source-a', rateLimitsByLimitId: {codex: {limitId: 'codex',
      primary: {usedPercent: 21, windowDurationMins: 300}}}}
    await value.service.refresh()
    assert.equal(usedPercent(value.service.status(value.accountA)), 21)
    assert.equal(value.service.status().codex.state, 'connecting')
    await value.service.cancelCodex()
    assert.equal(usedPercent(value.service.status(value.accountA)), 21)
  } finally { await value.close() }
})

test('logging out or changing one source leaves another source and its binding intact', async () => {
  const value = await multipleAccounts()
  try {
    await value.service.connectCodex()
    await value.service.linkCodex(value.accountA, value.service.status().codex.sourceKey!)
    await value.store.connect(credential('b'))
    const accountB = (await value.store.activeAccountId())!
    const secondId = await readySecond(value)
    await value.service.linkCodex(accountB, value.service.status().codex.sourceKey!)
    value.second.quota = {accountId: 'fixture-source-new', rateLimitsByLimitId: {codex: {limitId: 'codex',
      primary: {usedPercent: 60, windowDurationMins: 300}}}}
    await value.service.refresh()
    assert.equal(value.service.status(accountB).current, undefined)
    assert.equal(usedPercent(value.service.status(value.accountA)), 37)
    await value.service.linkCodex(accountB, value.service.status().codex.sourceKey!)
    await value.service.removeCodex(secondId)
    assert.equal(value.service.status(accountB).current, undefined)
    assert.equal(usedPercent(value.service.status(value.accountA)), 37)
    assert.equal(value.service.status().accounts?.length, 1)
    assert.ok(value.second.calls.some(call => call.method === 'account/logout'))
  } finally { await value.close() }
})

test('a duplicate source is rejected without disturbing the existing quota account', async () => {
  const value = await multipleAccounts()
  try {
    await value.service.connectCodex()
    await value.service.linkCodex(value.accountA, value.service.status().codex.sourceKey!)
    value.second.quota = value.first.quota
    await value.service.addCodex()
    value.second.account = {type: 'chatgpt', email: 'second@example.invalid'}
    value.second.emit({loginId: 'fixture-login', success: true})
    await settled(() => value.service.status().codex.state === 'unavailable')
    assert.match(value.service.status().codex.error!, /已连接/)
    assert.equal(usedPercent(value.service.status(value.accountA)), 37)
  } finally { await value.close() }
})

test('a remembered binding stays unavailable without a snapshot and can be removed offline', async () => {
  const value = await multipleAccounts()
  let restarted: QuotaService | undefined
  try {
    await value.service.connectCodex()
    await value.service.linkCodex(value.accountA, value.service.status().codex.sourceKey!)
    await value.store.connect(credential('b'))
    const accountB = (await value.store.activeAccountId())!
    const secondId = await readySecond(value)
    await value.service.linkCodex(accountB, value.service.status().codex.sourceKey!)
    await value.service.dispose()
    restarted = new QuotaService(value.store, value.profile, value.dependencies)
    await restarted.selectCodex(secondId)
    assert.equal(restarted.status(value.accountA).current?.state, 'unavailable')
    assert.equal(restarted.status(accountB).current?.state, 'unavailable')
    assert.equal(restarted.status(accountB).current?.snapshot, undefined)
    await restarted.removeCodex(secondId)
    assert.equal(restarted.status(accountB).current, undefined)
    assert.equal(restarted.status(value.accountA).current?.state, 'unavailable')
    const saved = new QuotaLinks(value.profile)
    await saved.load()
    assert.equal(saved.matches(accountB, value.service.status(accountB).codex.sourceKey!), false)
  } finally { await restarted?.dispose(); await value.close() }
})

test('a legacy login and its existing confirmed binding are restored without moving credentials', async () => {
  const value = await fixture()
  try {
    const home = join(value.profile, 'chatgpt-siwc-codex-quota')
    await mkdir(home, {recursive: true})
    await writeFile(join(home, 'auth.json'), '{}')
    const source = createHash('sha256').update(JSON.stringify(['codex', 'fixture-source-account'])).digest('hex')
    await new QuotaLinks(value.profile).bind(value.id!, source, true)
    value.rpc.account = {type: 'chatgpt', email: 'legacy@example.invalid'}
    await value.service.refresh()
    assert.equal(value.service.status(value.id).current?.state, 'ready')
    assert.equal(value.service.status().selectedAccountId, 'legacy')
    assert.equal(value.service.status().accounts?.length, 1)
  } finally { await value.close() }
})

test('an omitted stable source ID retains the previous confirmed link until identity returns', async () => {
  const value = await fixture()
  try {
    value.rpc.account = {type: 'chatgpt', email: 'first@example.invalid'}
    await value.service.connectCodex()
    await value.service.linkCodex(value.id!, value.service.status().codex.sourceKey!)
    const previous = value.service.status(value.id).current?.snapshot
    value.rpc.quota = {rateLimitsByLimitId: rpcQuota.rateLimitsByLimitId}
    await value.service.refresh()
    assert.equal(value.service.status(value.id).current?.state, 'unavailable')
    assert.deepEqual(value.service.status(value.id).current?.snapshot, previous)
    value.rpc.quota = rpcQuota
    await value.service.refresh()
    assert.equal(value.service.status(value.id).current?.state, 'ready')
  } finally { await value.close() }
})

test('a delayed old quota response does not invalidate a newer source and its binding', async () => {
  const value = await fixture()
  const entered = gate<void>()
  const delayed = gate<unknown>()
  try {
    value.rpc.account = {type: 'chatgpt', email: 'first@example.invalid'}
    await value.service.connectCodex()
    await value.service.linkCodex(value.id!, value.service.status().codex.sourceKey!)
    const original = value.rpc.request.bind(value.rpc)
    let delay = true
    value.rpc.request = async (method, params) => {
      if (method === 'account/rateLimits/read' && delay) {
        delay = false
        entered.resolve()
        return delayed.promise
      }
      return original(method, params)
    }
    const reading = value.service.refresh()
    await entered.promise
    await value.service.disconnectCodex()
    value.rpc.account = {type: 'chatgpt', email: 'second@example.invalid'}
    value.rpc.quota = {...rpcQuota, accountId: 'fixture-new-source'}
    await value.service.connectCodex()
    const source = value.service.status().codex.sourceKey!
    await value.service.linkCodex(value.id!, source)
    const before = value.service.status(value.id)
    delayed.resolve(rpcQuota)
    await reading
    assert.deepEqual(value.service.status(value.id), before)
    const links = new QuotaLinks(value.profile)
    await links.load()
    assert.equal(links.matches(value.id!, source), true)
  } finally { delayed.resolve(rpcQuota); await value.close() }
})

test('a delayed quota RPC startup failure cannot overwrite a cancelled connection', async () => {
  const value = await fixture()
  const entered = gate<void>()
  let rejectStart!: (error: Error) => void
  const startup = new Promise<FixtureRpc>((_resolve, reject) => { rejectStart = reject })
  try {
    const home = join(value.profile, 'chatgpt-siwc-codex-quota')
    await mkdir(home, {recursive: true})
    await writeFile(join(home, 'auth.json'), '{}')
    value.dependencies.start = async () => { entered.resolve(); return startup }
    const reading = value.service.refresh()
    await entered.promise
    await value.service.cancelCodex()
    rejectStart(new Error('fixture-startup-failure'))
    await reading
    assert.equal(value.service.status().codex.state, 'disconnected')
    assert.equal(value.service.status().codex.error, undefined)
  } finally { rejectStart(new Error('fixture-startup-failure')); await value.close() }
})
