import test from 'node:test'
import assert from 'node:assert/strict'
import type { CredentialKey, CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { AuthError, type Credential, type SiwcAuth } from '../src/auth/index.js'
import { AuthProtocol } from '../src/auth/protocol.js'
import { ConnectionStore } from '../src/storage/state.js'

class SerializedCredentials implements Pick<CredentialProvider, 'readRecord' | 'modifyRecord'> {
  private records = new Map<CredentialKey, string>()
  private pending: Promise<unknown> = Promise.resolve()
  async readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    const value = this.records.get(key)
    return value === undefined ? undefined : JSON.parse(value) as CredentialRecord
  }
  modifyRecord(key: CredentialKey,
    mutate: (record: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) {
    const operation = this.pending.then(async () => {
      const record = await mutate(await this.readRecord(key))
      if (record !== undefined) this.records.set(key, JSON.stringify(record))
      return this.readRecord(key)
    })
    this.pending = operation.catch(() => {})
    return operation
  }
}

function credentials(overrides: Partial<Credential> = {}): Credential {
  return {
    issuer: 'https://auth.openai.com', subject: 'synthetic-subject', issuedClientId: 'oaiapp_synthetic',
    hostId: 'urn:uuid:synthetic-host', schemaVersion: 1, accessToken: 'synthetic-access',
    refreshToken: 'synthetic-renewal', idToken: 'synthetic-identity',
    grantedScopes: ['chatgpt.tokens.use.direct'], receivedAt: Date.now(), expiresAt: Date.now() + 3_600_000,
    ...overrides,
  }
}

function auth(refresh: SiwcAuth['refresh']): Pick<SiwcAuth, 'refresh' | 'revoke'> {
  return { refresh, async revoke() {} }
}

function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

test('concurrent rejected access reuses one rotated credential under the DSH transaction', async () => {
  const provider = new SerializedCredentials()
  const entered = gate()
  const finish = gate()
  let calls = 0
  const renewal = auth(async value => {
    calls++
    assert.equal(value.accessToken, 'synthetic-access')
    entered.release()
    await finish.promise
    return credentials({accessToken: 'synthetic-next', refreshToken: 'synthetic-next-renewal'})
  })
  const first = new ConnectionStore(provider, '/synthetic/profile', renewal)
  const second = new ConnectionStore(provider, '/synthetic/profile', renewal)
  await first.connect(credentials())
  const initial = await first.connection()
  const requests = [first.connection(undefined, initial.accessToken), second.connection(undefined, initial.accessToken)]
  await entered.promise
  finish.release()
  const resolved = await Promise.all(requests)
  assert.equal(calls, 1)
  assert.deepEqual(resolved, [
    {...initial, accessToken: 'synthetic-next', credentialGeneration: 2},
    {...initial, accessToken: 'synthetic-next', credentialGeneration: 2},
  ])
  assert.equal((await second.read()).credential?.refreshToken, 'synthetic-next-renewal')
})

test('a cancelled waiter leaves renewal alive and its rotating credentials durably saved', async () => {
  const entered = gate()
  const finish = gate()
  let calls = 0
  const store = new ConnectionStore(new SerializedCredentials(), '/synthetic/profile', auth(async (_value, signal) => {
    calls++
    entered.release()
    await finish.promise
    assert.equal(signal?.aborted, false)
    return credentials({accessToken: 'synthetic-next', refreshToken: 'synthetic-next-renewal'})
  }))
  await store.connect(credentials({expiresAt: Date.now() + 10_000}))
  const cancellation = new AbortController()
  const request = store.connection(cancellation.signal)
  await entered.promise
  cancellation.abort()
  await assert.rejects(request, {name: 'AbortError'})
  finish.release()
  assert.equal((await store.connection()).accessToken, 'synthetic-next')
  assert.equal((await store.read()).credential?.refreshToken, 'synthetic-next-renewal')
  assert.equal(calls, 1)
})

test('pre-refresh temporary failure continues valid access but rejected or expired access stays unavailable', async () => {
  const store = new ConnectionStore(new SerializedCredentials(), '/synthetic/profile', auth(async () => {
    throw new AuthError('service_unavailable', 'Synthetic temporary failure')
  }))
  await store.connect(credentials({expiresAt: Date.now() + 10_000}))
  assert.equal((await store.connection()).accessToken, 'synthetic-access')
  await assert.rejects(store.connection(undefined, 'synthetic-access'), {code: 'service_unavailable'})
  assert.equal((await store.read()).credential?.refreshToken, 'synthetic-renewal')
  await store.connect(credentials({expiresAt: Date.now() - 1}))
  await assert.rejects(store.connection(), {code: 'service_unavailable'})
})

test('a rejected token observes server refresh timing while another rotated token is immediately usable', async () => {
  let calls = 0
  const store = new ConnectionStore(new SerializedCredentials(), '/synthetic/profile', auth(async () => {
    calls++
    return credentials()
  }))
  await store.connect(credentials({expiresAt: Date.now() + 10_000, earliestRefreshAt: Date.now() + 5_000}))
  await assert.rejects(store.connection(undefined, 'synthetic-access'), {code: 'refresh_unavailable'})
  assert.equal((await store.connection(undefined, 'synthetic-older')).accessToken, 'synthetic-access')
  assert.equal(calls, 0)
})

test('permanent grant failure persists sign-in-required state and keeps the registration identity', async () => {
  const store = new ConnectionStore(new SerializedCredentials(), '/synthetic/profile', auth(async () => {
    throw new AuthError('invalid_grant', 'Synthetic invalid grant')
  }))
  await store.connect(credentials())
  const original = await store.connection()
  await assert.rejects(store.connection(undefined, original.accessToken), {code: 'invalid_grant'})
  const saved = await store.read()
  assert.equal(saved.credential, undefined)
  assert.equal(saved.registration?.subject, 'synthetic-subject')
  await assert.rejects(store.connection(), {code: 'invalid_grant'})
})

test('renewed identity without plan scope is persisted and requires new plan consent', async () => {
  const store = new ConnectionStore(new SerializedCredentials(), '/synthetic/profile', auth(async () =>
    credentials({accessToken: 'synthetic-identity-only', grantedScopes: ['openid']})))
  await store.connect(credentials({expiresAt: Date.now() - 1}))
  await assert.rejects(store.connection(), {code: 'access_denied'})
  assert.equal((await store.read()).credential?.accessToken, 'synthetic-identity-only')
  await assert.rejects(store.connection(), {code: 'access_denied'})
})

test('OAuth exchange classifies permanent service codes and temporary denial without exposing provider details', async () => {
  for (const code of ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']) {
    const protocol = new AuthProtocol(async input => {
      if (String(input).endsWith('/.well-known/openid-configuration')) {
        return Response.json({issuer: 'https://auth.openai.com', authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize',
          token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token', jwks_uri: 'https://auth.openai.com/jwks'})
      }
      return Response.json({error: {code, message: 'synthetic-private-response'}}, {status: 400})
    })
    await assert.rejects(protocol.exchange({grant_type: 'refresh_token'}), (error: unknown) => {
      assert.ok(error instanceof AuthError)
      assert.equal(error.code, 'invalid_grant')
      assert.equal(error.message.includes('synthetic-private-response'), false)
      return true
    })
  }
  const protocol = new AuthProtocol(async () => Response.json({error: 'synthetic-private-response'}, {status: 403}))
  await assert.rejects(protocol.discovery(), {code: 'service_unavailable'})
})
