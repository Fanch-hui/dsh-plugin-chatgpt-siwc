import assert from 'node:assert/strict'
import test from 'node:test'
import type { CredentialKey, CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { BlockAssembler, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Controller } from '../src/api/controller.js'
import { SiwcAuth, type Credential } from '../src/auth/index.js'
import { ProviderError } from '../src/provider/errors.js'
import { ConnectionStore } from '../src/storage/state.js'

class MemoryCredentials implements Pick<CredentialProvider, 'readRecord' | 'modifyRecord'> {
  private readonly records = new Map<CredentialKey, string>()
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
    issuedClientId: `fixture-client-${name}`, hostId: 'fixture-host',
    accessToken: `fixture-access-${name}`, refreshToken: `fixture-refresh-${name}`, idToken: `fixture-identity-${name}`,
    grantedScopes: ['chatgpt.tokens.use.direct'], receivedAt: Date.now(), expiresAt: Date.now() + 3_600_000}
}

const options: GenerateOptions = {
  provider: 'chatgpt-siwc', model: 'fixture-model', sessionId: SessionId('fixture-session'),
  messages: [{role: 'user', content: [{type: 'text', text: 'Fixture request'}]}],
}

function quotaResponse(): Response {
  return Response.json({error: {code: 'subscription_sharing_usage_limit_exceeded'}}, {status: 429})
}

function quotaStreamResponse(): Response {
  const event = {type: 'response.failed', response: {error: {code: 'subscription_sharing_usage_limit_exceeded'}}}
  return new Response(`data: ${JSON.stringify(event)}\n\n`, {headers: {'content-type': 'text/event-stream'}})
}

function successResponse(): Response {
  const item = {type: 'message', id: 'fixture-message', role: 'assistant',
    content: [{type: 'output_text', text: 'Recovered'}]}
  const event = {type: 'response.completed', response: {id: 'fixture-response', status: 'completed', output: [item]}}
  return new Response(`data: ${JSON.stringify(event)}\n\n`, {headers: {'content-type': 'text/event-stream'}})
}

async function fixture(respond: () => Response | Promise<Response>) {
  const previousFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async input => {
    if (String(input).endsWith('/models')) {
      return Response.json({models: [{slug: 'fixture-model', display_name: 'Fixture model', visibility: 'list'}]})
    }
    assert.equal(String(input), 'https://api.openai.com/v1/responses')
    requests++
    return respond()
  }
  const auth = new SiwcAuth()
  const store = new ConnectionStore(new MemoryCredentials(), '/fixture/quota-recovery-profile', auth)
  await store.connect(credential('a'))
  const controller = new Controller(store, () => ({origin: 'user'}), undefined, auth, async () => {}, undefined,
    {websocket: false})
  return {controller, store, get requests() { return requests },
    async close() { await controller.dispose(); globalThis.fetch = previousFetch }}
}

async function generate(controller: Controller) {
  const assembler = new BlockAssembler()
  for await (const chunk of controller.adapter.stream(options)) assembler.push(chunk)
  return assembler.blocks()
}

function isProviderQuota(error: unknown): boolean {
  return error instanceof ProviderError && error.code === 'QUOTA' &&
    error.providerCode === 'subscription_sharing_usage_limit_exceeded'
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return {promise, resolve}
}

for (const [name, failure] of [['HTTP response', quotaResponse], ['stream event', quotaStreamResponse]] as const) {
  test(`a new conversation request recovers after a quota ${name}`, async () => {
    let quotaExhausted = true
    const value = await fixture(() => quotaExhausted ? failure() : successResponse())
    try {
      await assert.rejects(generate(value.controller), isProviderQuota)
      assert.equal(value.requests, 1)
      assert.equal((await value.controller.status()).availability, 'usage-limited')

      quotaExhausted = false
      assert.deepEqual(await generate(value.controller), [{type: 'text', text: 'Recovered'}])
      assert.equal(value.requests, 2)
      const status = await value.controller.status()
      assert.equal(status.availability, 'ready')
      assert.equal(status.error, undefined)
    } finally { await value.close() }
  })
}

test('each new request reaches the provider once while quota is still exhausted', async () => {
  const value = await fixture(quotaResponse)
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      await assert.rejects(generate(value.controller), isProviderQuota)
      assert.equal(value.requests, attempt)
      assert.equal((await value.controller.status()).availability, 'usage-limited')
    }
  } finally { await value.close() }
})

for (const scenario of [
  {name: 'quota error', oldResponse: quotaResponse, currentResponse: successResponse, availability: 'ready'},
  {name: 'success', oldResponse: successResponse, currentResponse: quotaResponse, availability: 'usage-limited'},
] as const) {
  test(`a late ${scenario.name} from the old account does not change the selected account status`, async () => {
    const started = deferred()
    const release = deferred()
    let first = true
    const value = await fixture(async () => {
      if (!first) return scenario.currentResponse()
      first = false
      started.resolve()
      await release.promise
      return scenario.oldResponse()
    })
    let oldRequest: Promise<unknown> | undefined
    try {
      const firstAccount = (await value.controller.status()).activeAccountId!
      await value.store.connect(credential('b'))
      const secondAccount = (await value.store.activeAccountId())!
      await value.controller.switchAccount(firstAccount)

      oldRequest = generate(value.controller).catch(error => { started.resolve(); return error })
      await started.promise
      assert.equal(value.requests, 1)
      await value.controller.switchAccount(secondAccount)
      if (scenario.availability === 'usage-limited') {
        await assert.rejects(generate(value.controller), isProviderQuota)
      } else {
        assert.deepEqual(await generate(value.controller), [{type: 'text', text: 'Recovered'}])
      }
      const before = await value.controller.status()
      assert.equal(before.activeAccountId, secondAccount)
      assert.equal(before.availability, scenario.availability)

      release.resolve()
      await oldRequest
      const after = await value.controller.status()
      assert.equal(after.activeAccountId, secondAccount)
      assert.equal(after.availability, scenario.availability)
      assert.equal(after.error, before.error)
      assert.equal(value.requests, 2)
    } finally {
      release.resolve()
      await oldRequest
      await value.close()
    }
  })
}
