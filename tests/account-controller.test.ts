import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { CredentialKey, CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Controller } from '../src/api/controller.js'
import { AuthError, SiwcAuth, type Credential, type SignInAttempt, type SignInOptions } from '../src/auth/index.js'
import { DiagnosticsStore } from '../src/diagnostics/store.js'
import { ConnectionStore, deriveReplayScope } from '../src/storage/state.js'

class MemoryCredentials implements Pick<CredentialProvider, 'readRecord' | 'modifyRecord'> {
  private records = new Map<CredentialKey, string>()
  private transaction: Promise<unknown> = Promise.resolve()
  async readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    const value = this.records.get(key)
    return value === undefined ? undefined : JSON.parse(value)
  }
  modifyRecord(key: CredentialKey, mutate: (value: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) {
    const operation = this.transaction.then(async () => {
      const next = await mutate(await this.readRecord(key))
      if (next !== undefined) this.records.set(key, JSON.stringify(next))
      return this.readRecord(key)
    })
    this.transaction = operation.catch(() => {})
    return operation
  }
}

function credential(name: string): Credential {
  return {schemaVersion: 1, issuer: 'https://auth.openai.com', subject: `fixture-${name}`,
    issuedClientId: `fixture-client-${name}`, hostId: 'fixture-host', displayEmail: `${name}@example.invalid`,
    accessToken: `fixture-access-${name}`, refreshToken: `fixture-refresh-${name}`, idToken: `fixture-identity-${name}`,
    grantedScopes: ['chatgpt.tokens.use.direct'], receivedAt: Date.now(), expiresAt: Date.now() + 3_600_000}
}

type Attempt = SignInAttempt & {resolve(value: Credential): void; reject(error: Error): void; cancelled: boolean}
class FixtureAuth extends SiwcAuth {
  readonly inputs: SignInOptions[] = []
  readonly attempts: Attempt[] = []
  readonly revoked: string[] = []
  override async beginSignIn(options: SignInOptions): Promise<SignInAttempt> {
    this.inputs.push(options)
    let resolve!: (value: Credential) => void
    let reject!: (error: Error) => void
    const completion = new Promise<Credential>((yes, no) => { resolve = yes; reject = no })
    const attempt: Attempt = {attemptId: `fixture-attempt-${this.attempts.length}`, authorizationUrl: 'https://fixture.invalid/login',
      completion, resolve, reject, cancelled: false, cancel() { this.cancelled = true }}
    this.attempts.push(attempt)
    return attempt
  }
  override async refresh(value: Credential): Promise<Credential> { return value }
  override async revoke(value: Credential): Promise<void> { this.revoked.push(value.subject) }
}

async function fixture(cacheMeasurements?: (number | undefined)[]) {
  const originalFetch = globalThis.fetch
  const signals: {account: string; signal?: AbortSignal | null}[] = []
  let requestIndex = 0
  globalThis.fetch = async (input, init) => {
    const account = new Headers(init?.headers).get('authorization')?.endsWith('-b') ? 'b' : 'a'
    if (String(input).endsWith('/models')) {
      signals.push({account, signal: init?.signal})
      return Response.json({models: [{slug: `model-${account}`, display_name: `Model ${account}`, visibility: 'list', context_window: 128000, max_context_window: 256000}]})
    }
    assert.equal(String(input), 'https://api.openai.com/v1/responses')
    const cached = cacheMeasurements ? cacheMeasurements[requestIndex++] : 4
    return new Response(`data: ${JSON.stringify({type: 'response.completed', response: {
      id: `fixture-response-${account}`, output: [{type: 'message', id: 'fixture-message', role: 'assistant',
        content: [{type: 'output_text', text: 'OK'}]}], usage: {input_tokens: 12, output_tokens: 3,
          ...(cached === undefined ? {} : {input_tokens_details: {cached_tokens: cached}})}}})}\n\n`, {headers: {'content-type': 'text/event-stream'}})
  }
  const auth = new FixtureAuth()
  const store = new ConnectionStore(new MemoryCredentials(), '/fixture/controller-profile', auth)
  await store.connect(credential('a'))
  const a = (await store.activeAccountId())!
  const controller = new Controller(store, () => undefined, undefined, auth, async () => {})
  return {controller, store, auth, signals, a,
    async close() { await controller.dispose(); globalThis.fetch = originalFetch }}
}

async function finishLogin(controller: Controller): Promise<void> {
  for (let count = 0; count < 20; count++) {
    await new Promise(resolve => setImmediate(resolve))
    if (!(await controller.status()).signingIn) return
  }
  assert.fail('Fixture login did not settle')
}

test('adding another account keeps the old account live until OAuth completes', async () => {
  const value = await fixture()
  try {
    const pending = await value.controller.addAccount()
    assert.equal(pending.signingIn, true)
    assert.equal(pending.activeAccountId, value.a)
    assert.equal(value.auth.inputs[0].registration, undefined)
    assert.equal((await value.controller.adapter.prepareCall('chatgpt-siwc', 'model-a')).model.id, 'model-a')
    const oldSignal = value.signals.at(-1)!.signal!
    value.auth.attempts[0].resolve(credential('b'))
    await finishLogin(value.controller)
    const status = await value.controller.status()
    assert.notEqual(status.activeAccountId, value.a)
    assert.equal(status.accounts.length, 2)
    assert.ok(status.accounts.every(account => account.authenticated))
    assert.equal(status.email, 'b@example.invalid')
    assert.deepEqual(status.models.map(model => model.id), ['model-b'])
    assert.equal(oldSignal.aborted, true)
  } finally { await value.close() }
})

test('reauthorizing a saved account uses its registration and a failed login preserves the active account', async () => {
  const value = await fixture()
  try {
    await value.store.connect(credential('b'))
    const b = (await value.store.activeAccountId())!
    await value.controller.reauthorizeAccount(value.a)
    assert.equal(value.auth.inputs[0].registration?.subject, 'fixture-a')
    assert.equal(value.auth.inputs[0].registration?.issuedClientId, 'fixture-client-a')
    assert.equal(value.auth.inputs[0].registration?.idToken, 'fixture-identity-a')
    value.auth.attempts[0].reject(new AuthError('access_denied', 'Fixture login declined'))
    await finishLogin(value.controller)
    const status = await value.controller.status()
    assert.equal(status.activeAccountId, b)
    assert.equal(status.authenticated, true)
    assert.equal(status.error, 'Fixture login declined')
    assert.equal((await value.store.accounts()).length, 2)
  } finally { await value.close() }
})

test('switching cancels the old connection and signing out only clears the selected account', async () => {
  const value = await fixture()
  try {
    await value.store.connect(credential('b'))
    const b = (await value.store.activeAccountId())!
    await value.controller.adapter.prepareCall('chatgpt-siwc', 'model-b')
    const bSignal = value.signals.at(-1)!.signal!
    const switched = await value.controller.switchAccount(value.a)
    assert.equal(bSignal.aborted, true)
    assert.equal(switched.activeAccountId, value.a)
    assert.deepEqual(switched.models.map(model => model.id), ['model-a'])
    const aSignal = value.signals.at(-1)!.signal!
    const inactiveExit = await value.controller.removeAccount(b)
    assert.equal(aSignal.aborted, false)
    assert.equal(inactiveExit.activeAccountId, value.a)
    assert.equal(inactiveExit.accounts.find(account => account.id === b)?.authenticated, false)
    assert.deepEqual(value.auth.revoked, ['fixture-b'])
    assert.equal((await value.store.returningRegistration(b))?.issuedClientId, 'fixture-client-b')
    const exited = await value.controller.signOut()
    assert.equal(aSignal.aborted, true)
    assert.equal(exited.authenticated, false)
    assert.deepEqual(value.auth.revoked, ['fixture-b', 'fixture-a'])
  } finally { await value.close() }
})

test('cancelled or superseded login completions cannot replace the active account', async () => {
  const value = await fixture()
  try {
    await value.controller.addAccount()
    await value.controller.cancelSignIn()
    assert.equal(value.auth.attempts[0].cancelled, true)
    value.auth.attempts[0].resolve(credential('b'))
    await finishLogin(value.controller)
    assert.equal((await value.controller.status()).activeAccountId, value.a)
    await value.controller.addAccount()
    await value.controller.addAccount()
    assert.equal(value.auth.attempts[1].cancelled, true)
    value.auth.attempts[1].resolve(credential('b'))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal((await value.controller.status()).activeAccountId, value.a)
    await value.controller.cancelSignIn()
    value.auth.attempts[2].resolve(credential('b'))
    await finishLogin(value.controller)
    assert.equal((await value.controller.status()).accounts.length, 1)
  } finally { await value.close() }
})

test('completed stream usage remains assigned to its account after switching', async () => {
  const value = await fixture()
  try {
    await value.controller.setBackgroundAllowed(true)
    const call = await value.controller.adapter.prepareCall('chatgpt-siwc', 'model-a')
    for await (const _chunk of call.stream({provider: 'chatgpt-siwc', model: 'model-a',
      messages: [{role: 'user', content: [{type: 'text', text: 'Fixture request'}]}]})) {}
    await value.store.connect(credential('b'))
    const b = (await value.store.activeAccountId())!
    await value.controller.switchAccount(b)
    assert.deepEqual((await value.controller.status()).usage, {requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0})
    const restored = await value.controller.switchAccount(value.a)
    assert.deepEqual(restored.usage, {requests: 1, inputTokens: 12, outputTokens: 3, cachedTokens: 4,
      cacheMeasuredInputTokens: 12, cacheMeasuredTokens: 4})
  } finally { await value.close() }
})

test('controller records explicit zero cache usage and excludes absent cache metering from hit totals', async () => {
  const value = await fixture([4, undefined, 0])
  try {
    for (let index = 0; index < 3; index++) {
      const call = await value.controller.adapter.prepareCall('chatgpt-siwc', 'model-a')
      for await (const _chunk of call.stream({provider: 'chatgpt-siwc', model: 'model-a',
        messages: [{role: 'user', content: [{type: 'text', text: 'Fixture request'}]}]})) {}
    }
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual((await value.controller.status()).usage, {requests: 3, inputTokens: 36, outputTokens: 9,
      cachedTokens: 4, cacheMeasuredInputTokens: 24, cacheMeasuredTokens: 4})
  } finally { await value.close() }
})

test('signing out the active account selects another saved connection and its model catalog', async () => {
  const value = await fixture()
  try {
    await value.store.connect(credential('b'))
    await value.controller.refreshModels()
    const previousSignal = value.signals.at(-1)!.signal!
    const status = await value.controller.signOut()
    assert.equal(previousSignal.aborted, true)
    assert.equal(status.activeAccountId, value.a)
    assert.equal(status.authenticated, true)
    assert.deepEqual(status.models.map(model => model.id), ['model-a'])
    assert.deepEqual(status.accounts.map(account => account.authenticated), [true, false])
  } finally { await value.close() }
})


test('context window settings persist per account and feed DSH model resolution', async () => {
  const value = await fixture()
  try {
    await value.controller.refreshModels()
    const setting = {accountId: value.a, modelId: 'model-a', contextWindow: 192000}
    const saved = await value.controller.setContextWindow(setting)
    assert.equal(saved.models[0].contextWindow, 192000)
    assert.equal(saved.models[0].defaultContextWindow, 128000)
    assert.equal(saved.models[0].maxContextWindow, 256000)
    assert.equal((await value.controller.adapter.resolveModel('chatgpt-siwc', 'model-a')).context?.contextWindow, 192000)
    assert.equal((await value.controller.adapter.prepareCall('chatgpt-siwc', 'model-a')).model.context?.contextWindow, 192000)
    const restarted = new Controller(value.store, () => undefined, undefined, value.auth, async () => {})
    try {
      assert.equal((await restarted.adapter.resolveModel('chatgpt-siwc', 'model-a')).context?.contextWindow, 192000)
    } finally { await restarted.dispose() }
    await assert.rejects(value.controller.setContextWindow({...setting, contextWindow: 300000}), {code: 'SIWC_INVALID_CONTEXT_WINDOW'})
    await value.store.connect(credential('b'))
    const b = (await value.store.activeAccountId())!
    await value.controller.switchAccount(b)
    await assert.rejects(value.controller.setContextWindow({...setting, modelId: 'model-b'}), {code: 'SIWC_CONNECTION_CHANGED'})
    assert.equal((await value.controller.adapter.resolveModel('chatgpt-siwc', 'model-b')).context?.contextWindow, 128000)
    await value.controller.switchAccount(value.a)
    assert.equal((await value.controller.status()).models[0].contextWindowOverride, 192000)
    const restored = await value.controller.setContextWindow({...setting, contextWindow: null})
    assert.equal(restored.models[0].contextWindowOverride, undefined)
    assert.equal((await value.controller.adapter.resolveModel('chatgpt-siwc', 'model-a')).context?.contextWindow, 128000)
  } finally { await value.close() }
})

test('restarted Controller loads persisted diagnostics secret before first request and matches prefix baseline', async () => {
  const originalFetch = globalThis.fetch
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-siwc-ctrl-diag-'))
  let turn = 0
  globalThis.fetch = async (input) => {
    if (String(input).endsWith('/models')) {
      return Response.json({ models: [{ slug: 'model-a', display_name: 'Model A', visibility: 'list' }] })
    }
    turn++
    return new Response(`data: ${JSON.stringify({
      type: 'response.completed',
      response: {
        id: `resp-turn-${turn}`,
        output: [{ type: 'message', id: `msg-turn-${turn}`, role: 'assistant', content: [{ type: 'output_text', text: `Reply ${turn}` }] }],
        usage: { input_tokens: 20, output_tokens: 4, input_tokens_details: { cached_tokens: 10 } },
      },
    })}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
  }
  const credentials = new MemoryCredentials()
  const auth = new FixtureAuth()
  try {
    const store1 = new ConnectionStore(credentials, profileDir, auth)
    await store1.connect(credential('a'))
    const diag1 = new DiagnosticsStore(profileDir)
    const controller1 = new Controller(store1, () => ({ origin: 'user' }), undefined, auth, async () => {}, undefined, {
      sessionScope: profileDir, websocket: false,
    }, undefined, diag1)

    const user1 = { role: 'user' as const, content: [{ type: 'text' as const, text: 'Hello turn 1' }] }
    const assembler1 = new BlockAssembler()
    const call1 = await controller1.adapter.prepareCall('chatgpt-siwc', 'model-a')
    for await (const chunk of call1.stream({
      provider: 'chatgpt-siwc', model: 'model-a', sessionId: SessionId('sess-restart'), messages: [user1],
    })) {
      assembler1.push(chunk)
    }
    const assistant1 = assembler1.message({
      provider: 'chatgpt-siwc', model: 'model-a', replayState: assembler1.replayState,
    })
    const status1 = await controller1.status()
    const firstRecord = status1.diagnostics?.recent[0]
    assert.ok(firstRecord)
    await controller1.dispose()

    const store2 = new ConnectionStore(credentials, profileDir, auth)
    const diag2 = new DiagnosticsStore(profileDir)
    const controller2 = new Controller(store2, () => ({ origin: 'user' }), undefined, auth, async () => {}, undefined, {
      sessionScope: profileDir, websocket: false,
    }, undefined, diag2)
    try {
      const user2 = { role: 'user' as const, content: [{ type: 'text' as const, text: 'Hello turn 2' }] }
      const call2 = await controller2.adapter.prepareCall('chatgpt-siwc', 'model-a')
      for await (const _chunk of call2.stream({
        provider: 'chatgpt-siwc', model: 'model-a', sessionId: SessionId('sess-restart'), messages: [user1, assistant1, user2],
      })) {}
      const status2 = await controller2.status()
      const secondRecord = status2.diagnostics?.recent[0]
      assert.ok(secondRecord)
      assert.equal(secondRecord.prefix?.change, 'append')
      assert.equal(secondRecord.baselineRequestId, firstRecord.id)
      assert.equal(secondRecord.keyId, firstRecord.keyId)
    } finally {
      await controller2.dispose()
    }
  } finally {
    globalThis.fetch = originalFetch
    rmSync(profileDir, { recursive: true, force: true })
  }
})

test('cacheSettings persist, probe capabilities, hydrate across Controller restart, and fallback on unsupported parameters', async () => {
  const originalFetch = globalThis.fetch
  const bodies: Record<string, unknown>[] = []
  let failCacheOptionsOnce = false
  let responseSeq = 0
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith('/models')) {
      return Response.json({ models: [{ slug: 'model-a', display_name: 'Model A', visibility: 'list' }] })
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    bodies.push(body)
    responseSeq++
    if (failCacheOptionsOnce && body.prompt_cache_options) {
      failCacheOptionsOnce = false
      return new Response(`data: ${JSON.stringify({
        type: 'response.failed',
        response: {
          id: `resp-err-${responseSeq}`,
          error: { code: 'unknown_parameter', param: 'prompt_cache_options', message: 'Unsupported parameter: prompt_cache_options' },
        },
      })}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response(`data: ${JSON.stringify({
      type: 'response.completed',
      response: {
        id: `resp-ok-${responseSeq}`,
        output: [{ type: 'message', id: `msg-${responseSeq}`, role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }],
        usage: { input_tokens: 15, output_tokens: 3, input_tokens_details: { cached_tokens: 5 } },
      },
    })}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
  }
  const credentials = new MemoryCredentials()
  const auth = new FixtureAuth()
  const profileDir = '/fixture/cache-settings-profile'
  try {
    const store1 = new ConnectionStore(credentials, profileDir, auth)
    await store1.connect(credential('a'))
    const accountId = (await store1.activeAccountId())!
    const replayScope = deriveReplayScope(store1.profileScope, accountId, 1)
    const controller1 = new Controller(store1, () => ({ origin: 'user' }), undefined, auth, async () => {}, undefined, {
      sessionScope: profileDir, websocket: false,
    })

    const updated = await controller1.setCacheSettings({
      ttl: '12h',
      comparisonDiagnostics: true,
      configurationUpdate: true,
      toolAdditions: true,
    })
    assert.deepEqual(updated.cacheSettings, {
      ttl: '12h',
      comparisonDiagnostics: true,
      configurationUpdate: true,
      toolAdditions: true,
    })

    const user1 = { role: 'user' as const, content: [{ type: 'text' as const, text: 'Turn 1' }] }
    const assembler1 = new BlockAssembler()
    const call1 = await controller1.adapter.prepareCall('chatgpt-siwc', 'model-a')
    for await (const chunk of call1.stream({
      provider: 'chatgpt-siwc', model: 'model-a', sessionId: SessionId('sess-cache'), messages: [user1],
    })) {
      assembler1.push(chunk)
    }
    assert.deepEqual(bodies[0].prompt_cache_options, { mode: 'implicit', ttl: '12h' })
    assert.equal((await store1.readCapability(accountId, 1, 'model-a', 'prompt_cache_options'))?.status, 'supported')
    assert.equal((await store1.readCapability(accountId, 1, 'model-a', 'prompt_cache_options'))?.projectionVersion, 2)
    assert.equal(await store1.readCapability(accountId, 1, 'model-a', 'configuration_update'), undefined)
    assert.equal(await store1.readCapability(accountId, 1, 'model-a', 'additional_tools'), undefined)

    const assistant1 = assembler1.message({
      provider: 'chatgpt-siwc', model: 'model-a', replayState: assembler1.replayState,
    })
    await controller1.dispose()

    const store2 = new ConnectionStore(credentials, profileDir, auth)
    const controller2 = new Controller(store2, () => ({ origin: 'user' }), undefined, auth, async () => {}, undefined, {
      sessionScope: profileDir, websocket: false,
    })
    try {
      const status2 = await controller2.status()
      assert.deepEqual(status2.cacheSettings, {
        ttl: '12h',
        comparisonDiagnostics: true,
        configurationUpdate: true,
        toolAdditions: true,
      })
      assert.equal(controller2.adapter.capabilities.status(replayScope, 'model-a', 'prompt_cache_options'), 'supported')

      failCacheOptionsOnce = true
      const user2 = { role: 'user' as const, content: [{ type: 'text' as const, text: 'Turn 2' }] }
      const chunks2 = []
      const call2 = await controller2.adapter.prepareCall('chatgpt-siwc', 'model-a')
      for await (const chunk of call2.stream({
        provider: 'chatgpt-siwc', model: 'model-a', sessionId: SessionId('sess-cache'), messages: [user1, assistant1, user2],
      })) {
        chunks2.push(chunk)
      }
      assert.ok(chunks2.some(chunk => chunk.type === 'finish'))
      assert.equal(bodies.length, 3)
      assert.deepEqual(bodies[1].prompt_cache_options, {
        mode: 'implicit',
        ttl: '12h',
        comparison_response_id: 'resp-ok-1',
      })
      assert.equal('prompt_cache_options' in bodies[2], false)
      assert.equal(controller2.adapter.capabilities.status(replayScope, 'model-a', 'prompt_cache_options'), 'unsupported')
      assert.equal((await store2.readCapability(accountId, 1, 'model-a', 'prompt_cache_options'))?.status, 'unsupported')
    } finally {
      await controller2.dispose()
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})
