import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { credentialKey, type CredentialKey, type CredentialProvider, type CredentialRecord } from '@deepseek-ai/dsh-credentials';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import { AuthError, type Credential, type SiwcAuth } from '../src/auth/index.js';
import { ConnectionStore, type StoredState } from '../src/storage/state.js';
import { authorizeCall } from '../src/policy/authorize.js';

/** Reproduces the provider's serialized transaction and JSON persistence boundary. */
class SerializedProvider implements Pick<CredentialProvider, 'readRecord' | 'modifyRecord'> {
  private records = new Map<CredentialKey, string>();
  private queues = new Map<CredentialKey, Promise<void>>();

  async readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    const stored = this.records.get(key);
    return stored === undefined ? undefined : JSON.parse(stored) as CredentialRecord;
  }

  async modifyRecord(key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    this.queues.set(key, current);
    await previous;
    try {
      const next = await mutate(await this.readRecord(key));
      if (next !== undefined) this.records.set(key, JSON.stringify(next));
      return await this.readRecord(key);
    } finally {
      release();
      if (this.queues.get(key) === current) this.queues.delete(key);
    }
  }
}

function credential(overrides: Partial<Credential> = {}): Credential {
  return {
    schemaVersion: 1, issuer: 'https://auth.openai.com', subject: 'fixture-subject',
    issuedClientId: 'oaiapp_fixture', hostId: 'urn:uuid:fixture-host', displayEmail: 'fixture@example.invalid',
    accessToken: 'fixture-access', refreshToken: 'fixture-refresh', idToken: 'fixture-id',
    grantedScopes: ['openid', 'chatgpt.tokens.use.direct'],
    receivedAt: Date.now(), expiresAt: Date.now() + 3_600_000, ...overrides,
  };
}

function auth(overrides: Partial<Pick<SiwcAuth, 'refresh' | 'revoke'>> = {}): Pick<SiwcAuth, 'refresh' | 'revoke'> {
  return {
    async refresh() { throw new Error('Unexpected refresh'); },
    async revoke() {},
    ...overrides,
  };
}

test('concurrent stores serialize refresh and save the complete rotated credential once', async () => {
  const provider = new SerializedProvider();
  let count = 0;
  let releaseRefresh!: () => void;
  let markStarted!: () => void;
  const release = new Promise<void>(resolve => { releaseRefresh = resolve; });
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const renewal = auth({ async refresh(value) {
    count++;
    assert.equal(value.refreshToken, 'fixture-refresh');
    markStarted();
    await release;
    return credential({ accessToken: 'fixture-rotated-access', refreshToken: 'fixture-rotated-refresh',
      idToken: 'fixture-rotated-id', grantedScopes: ['chatgpt.tokens.use.direct'],
      earliestRefreshAt: Date.now() + 120_000 });
  } });
  const first = new ConnectionStore(provider, '/fixture/profile-a', renewal);
  const second = new ConnectionStore(provider, '/fixture/profile-a', renewal);
  await first.connect(credential({ expiresAt: Date.now() + 1_000 }));
  const calls = [first.connection(), second.connection(), first.connection()];
  await started;
  releaseRefresh();
  const values = await Promise.all(calls);
  assert.equal(count, 1);
  assert.equal(new Set(values.map(value => value.id)).size, 1);
  assert.deepEqual(values.map(value => value.accessToken), Array(3).fill('fixture-rotated-access'));
  const saved = (await second.read()).credential!;
  assert.equal(saved.refreshToken, 'fixture-rotated-refresh');
  assert.equal(saved.idToken, 'fixture-rotated-id');
  assert.deepEqual(saved.grantedScopes, ['chatgpt.tokens.use.direct']);
  assert.ok(saved.earliestRefreshAt! > saved.receivedAt);
});

test('invalid grant clears credentials while retaining registration for reauthorization', async () => {
  const store = new ConnectionStore(new SerializedProvider(), '/fixture/profile', auth({
    async refresh() { throw new AuthError('invalid_grant', 'Fixture expired authorization'); },
  }));
  await store.connect(credential({ expiresAt: Date.now() - 1 }));
  const revision = (await store.read()).revision;
  await assert.rejects(store.connection(), { code: 'invalid_grant' });
  const state = await store.read();
  assert.equal(state.credential, undefined);
  assert.equal(state.revision, revision + 1);
  assert.equal(state.registration?.issuedClientId, 'oaiapp_fixture');
  const returning = await store.returningRegistration();
  assert.equal(returning?.subject, 'fixture-subject');
  assert.equal(returning?.idToken, undefined);
  assert.equal('accessToken' in returning!, false);
});

test('server refresh window preserves valid access and rejects expired access until renewal opens', async () => {
  const store = new ConnectionStore(new SerializedProvider(), '/fixture/refresh-window', auth());
  await store.connect(credential({ expiresAt: Date.now() + 20_000, earliestRefreshAt: Date.now() + 10_000 }));
  assert.equal((await store.connection()).accessToken, 'fixture-access');
  await store.connect(credential({ expiresAt: Date.now() - 1, earliestRefreshAt: Date.now() + 10_000 }));
  await assert.rejects(store.connection(), { code: 'refresh_unavailable' });
  assert.equal((await store.read()).credential?.refreshToken, 'fixture-refresh');
});

test('transient refresh failure preserves current credentials and permits a subsequent retry', async () => {
  let calls = 0;
  const store = new ConnectionStore(new SerializedProvider(), '/fixture/profile', auth({ async refresh() {
    if (++calls === 1) throw new AuthError('network_error', 'Fixture network failure');
    return credential({ accessToken: 'fixture-recovered' });
  } }));
  await store.connect(credential({ expiresAt: Date.now() + 1_000 }));
  assert.equal((await store.connection()).accessToken, 'fixture-access');
  assert.equal((await store.read()).credential?.refreshToken, 'fixture-refresh');
  assert.equal((await store.connection()).accessToken, 'fixture-recovered');
});

test('sign-out revokes before clearing tokens and retains the registration mapping', async () => {
  const revoked: string[] = [];
  const store = new ConnectionStore(new SerializedProvider(), '/fixture/profile', auth({ async revoke(value) {
    revoked.push(value.refreshToken!);
  } }));
  await store.connect(credential());
  await store.update(state => { state.authorizedSessions = ['session-a']; state.allowBackground = true; });
  assert.equal(await store.signOut(), true);
  assert.deepEqual(revoked, ['fixture-refresh']);
  const state = await store.read();
  assert.equal(state.credential, undefined);
  assert.equal(state.registration?.issuedClientId, 'oaiapp_fixture');
  assert.deepEqual(state.authorizedSessions, []);
  assert.equal(state.allowBackground, true);
  await assert.rejects(store.connection(), { code: 'invalid_grant' });
  assert.equal((await store.returningRegistration())?.idToken, undefined);
});

test('remote revocation failure reports its result and still clears local credentials', async () => {
  const store = new ConnectionStore(new SerializedProvider(), '/fixture/profile', auth({
    async revoke() { throw new AuthError('network_error', 'Fixture network failure'); },
  }));
  await store.connect(credential());
  assert.equal(await store.signOut(), false);
  assert.equal((await store.read()).credential, undefined);
  assert.equal((await store.returningRegistration())?.issuedClientId, 'oaiapp_fixture');
});

test('host identity is stable across profiles while connection and consent are profile-scoped', async () => {
  const provider = new SerializedProvider();
  const a = new ConnectionStore(provider, '/fixture/profile-a', auth());
  const aRestart = new ConnectionStore(provider, '/fixture/profile-a', auth());
  const b = new ConnectionStore(provider, '/fixture/profile-b', auth());
  const hostIds = await Promise.all([a.hostId(), b.hostId(), aRestart.hostId()]);
  assert.equal(new Set(hostIds).size, 1);
  assert.match(hostIds[0], /^urn:uuid:/);
  await a.connect(credential({ hostId: hostIds[0] }));
  await a.update(state => { state.authorizedSessions.push('session-a'); });
  assert.equal((await aRestart.read()).credential?.subject, 'fixture-subject');
  assert.deepEqual((await aRestart.read()).authorizedSessions, ['session-a']);
  assert.equal((await b.read()).credential, undefined);
  assert.deepEqual((await b.read()).authorizedSessions, []);
  const otherHost = new ConnectionStore(new SerializedProvider(), '/fixture/profile-a', auth());
  assert.notEqual(await otherHost.hostId(), hostIds[0]);
});

test('reconnecting replaces credentials and clears prior task/background consent', async () => {
  const store = new ConnectionStore(new SerializedProvider(), '/fixture/profile', auth());
  await store.connect(credential());
  await store.update(state => { state.authorizedSessions = ['session-a']; state.allowBackground = true; });
  await store.connect(credential({ subject: 'fixture-other', issuedClientId: 'oaiapp_other' }));
  const state = await store.read();
  assert.equal(state.registration?.subject, 'fixture-other');
  assert.equal(state.credential?.issuedClientId, 'oaiapp_other');
  assert.deepEqual(state.authorizedSessions, []);
  assert.equal(state.allowBackground, true);
});

function options(id?: string, purpose?: GenerateOptions['purpose']): GenerateOptions {
  return { provider: 'chatgpt-siwc', model: 'fixture-model', messages: [],
    sessionId: id as GenerateOptions['sessionId'], purpose };
}

async function policyState(): Promise<StoredState> {
  const store = new ConnectionStore(new SerializedProvider(), '/fixture/profile', auth());
  await store.connect(credential());
  return store.update(state => { state.authorizedSessions = ['user-task']; });
}

test('all sessions can use the plan immediately after connecting', async () => {
  const store = new ConnectionStore(new SerializedProvider(), '/fixture/profile', auth());
  await store.connect(credential());
  const state = await store.read();
  assert.deepEqual(state.authorizedSessions, []);
  for (const id of ['new-session', 'existing-session', 'subagent', 'fork', 'scheduled-task']) {
    for (const purpose of [undefined, 'compaction', 'session-title'] as const) {
      assert.doesNotThrow(() => authorizeCall(state, options(id, purpose)));
    }
  }
});

test('independent calls respect the background switch without affecting sessions', async () => {
  const state = await policyState();
  assert.doesNotThrow(() => authorizeCall(state, options()));
  state.allowBackground = true;
  assert.doesNotThrow(() => authorizeCall(state, options(undefined, 'session-title')));
  state.allowBackground = false;
  assert.throws(() => authorizeCall(state, options()), { code: 'SIWC_CONSENT_REQUIRED' });
  assert.doesNotThrow(() => authorizeCall(state, options('new-session')));
});


test('v1 credentials migrate atomically with their registration, preferences and usage', async () => {
  const provider = new SerializedProvider();
  const key = credentialKey('chatgpt-siwc', `profile-${createHash('sha256').update('/fixture/migration').digest('hex')}`);
  const value = credential();
  await provider.modifyRecord(key, async () => ({kind: 'grant', payload: {
    schemaVersion: 1, revision: 7, credential: value,
    registration: {issuer: value.issuer, subject: value.subject, issuedClientId: value.issuedClientId,
      hostId: value.hostId, displayEmail: value.displayEmail},
    authorizedSessions: ['session-existing'], allowBackground: true,
    usage: {requests: 5, inputTokens: 20, outputTokens: 10, cachedTokens: 3},
  }}));
  const store = new ConnectionStore(provider, '/fixture/migration', auth());
  const old = await store.read();
  assert.equal(old.credential?.refreshToken, 'fixture-refresh');
  assert.equal(old.revision, 7);
  assert.equal((await store.accounts()).length, 1);
  await store.update(state => { state.usage.requests++; });
  const persisted = await provider.readRecord(key);
  assert.ok(persisted?.kind === 'grant');
  assert.equal((persisted.payload as {schemaVersion: number}).schemaVersion, 3);
  const restarted = new ConnectionStore(provider, '/fixture/migration', auth());
  assert.deepEqual((await restarted.read()).authorizedSessions, ['session-existing']);
  assert.equal((await restarted.read()).allowBackground, true);
  assert.equal((await restarted.read()).usage.requests, 6);
  assert.equal((await restarted.read()).usage.cacheMeasuredInputTokens, undefined);
  assert.equal((await restarted.read()).usage.cacheMeasuredTokens, undefined);
  assert.equal((await restarted.returningRegistration())?.issuedClientId, value.issuedClientId);
  await restarted.connect(value);
  assert.equal(await restarted.activeAccountId(), old.accountId);
  assert.equal((await restarted.accounts()).length, 1);
  assert.equal((await restarted.read()).allowBackground, true);
  assert.equal((await restarted.read()).usage.requests, 6);
});

test('accounts preserve registrations, independent usage and settings across switching and reauthorization', async () => {
  const store = new ConnectionStore(new SerializedProvider(), '/fixture/accounts', auth());
  await store.connect(credential());
  const first = (await store.activeAccountId())!;
  const firstConnection = await store.connection();
  await store.update(state => { state.allowBackground = true; });
  await store.recordUsage(first, {requests: 1, inputTokens: 13, outputTokens: 4, cachedTokens: 2});
  await store.connect(credential({subject: 'fixture-second', issuedClientId: 'oaiapp_second'}));
  const second = (await store.activeAccountId())!;
  assert.notEqual(first, second);
  assert.notEqual((await store.connection()).id, firstConnection.id);
  assert.equal((await store.read()).usage.requests, 0);
  assert.equal((await store.read()).allowBackground, true);
  await store.recordUsage(first, {requests: 1, inputTokens: 7, outputTokens: 2, cachedTokens: 1});
  assert.equal((await store.read()).usage.requests, 0);
  await store.switchAccount(first);
  assert.equal((await store.read()).allowBackground, true);
  assert.deepEqual((await store.read()).usage, {requests: 2, inputTokens: 20, outputTokens: 6, cachedTokens: 3});
  assert.equal((await store.connection()).accountId, first);
  await store.connect(credential({accessToken: 'fixture-relogin'}));
  assert.equal((await store.accounts()).length, 2);
  assert.equal((await store.activeAccountId()), first);
  assert.equal((await store.read()).usage.requests, 2);
  assert.equal((await store.read()).allowBackground, true);
  await store.connect(credential({issuedClientId: 'oaiapp_other_workspace'}));
  assert.equal((await store.accounts()).length, 3);
  await assert.rejects(store.switchAccount('missing'), /账号不存在/);
  await assert.rejects(store.returningRegistration('missing'), /账号不存在/);
  assert.equal((await store.returningRegistration(second))?.subject, 'fixture-second');
});

test('cache hit totals count measured requests independently and persist per account', async () => {
  const provider = new SerializedProvider();
  const store = new ConnectionStore(provider, '/fixture/measured-cache', auth());
  await store.connect(credential());
  const first = (await store.activeAccountId())!;
  await store.recordUsage(first, {requests: 1, inputTokens: 40, outputTokens: 3, cachedTokens: 10});
  assert.equal((await store.read()).usage.cacheMeasuredInputTokens, undefined);
  assert.equal((await store.read()).usage.cacheMeasuredTokens, undefined);
  await store.recordUsage(first, {requests: 1, inputTokens: 100, outputTokens: 4, cachedTokens: 60,
    cacheMeasuredInputTokens: 100, cacheMeasuredTokens: 60});
  await store.recordUsage(first, {requests: 1, inputTokens: 200, outputTokens: 3, cachedTokens: 0});
  await store.connect(credential({subject: 'fixture-second', issuedClientId: 'oaiapp_second'}));
  const second = (await store.activeAccountId())!;
  await store.recordUsage(second, {requests: 1, inputTokens: 20, outputTokens: 2, cachedTokens: 5,
    cacheMeasuredInputTokens: 20, cacheMeasuredTokens: 5});
  await store.recordUsage(first, {requests: 1, inputTokens: 50, outputTokens: 2, cachedTokens: 0,
    cacheMeasuredInputTokens: 50, cacheMeasuredTokens: 0});
  const restarted = new ConnectionStore(provider, '/fixture/measured-cache', auth());
  assert.equal((await restarted.read()).usage.cacheMeasuredInputTokens, 20);
  assert.equal((await restarted.read()).usage.cacheMeasuredTokens, 5);
  await restarted.switchAccount(first);
  assert.deepEqual((await restarted.read()).usage, {requests: 4, inputTokens: 390, outputTokens: 12, cachedTokens: 70,
    cacheMeasuredInputTokens: 150, cacheMeasuredTokens: 60});
  await restarted.connect(credential({accessToken: 'fixture-relogin'}));
  assert.equal((await restarted.read()).usage.cacheMeasuredInputTokens, 150);
  assert.equal((await restarted.read()).usage.cacheMeasuredTokens, 60);
});

test('exiting a selected account keeps its registration and activates another connected account', async () => {
  const revoked: string[] = [];
  const store = new ConnectionStore(new SerializedProvider(), '/fixture/accounts', auth({async revoke(value) {
    revoked.push(value.issuedClientId);
  }}));
  await store.connect(credential());
  const first = (await store.activeAccountId())!;
  await store.connect(credential({subject: 'fixture-second', issuedClientId: 'oaiapp_second'}));
  const second = (await store.activeAccountId())!;
  await store.switchAccount(first);
  assert.equal(await store.removeAccount(second), true);
  assert.equal(await store.activeAccountId(), first);
  assert.equal((await store.accounts()).find(account => account.id === second)?.authenticated, false);
  assert.equal((await store.returningRegistration(second))?.issuedClientId, 'oaiapp_second');
  await store.connect(credential({subject: 'fixture-second', issuedClientId: 'oaiapp_second'}));
  assert.equal(await store.removeAccount(second), true);
  assert.equal(await store.activeAccountId(), first);
  assert.deepEqual(revoked, ['oaiapp_second', 'oaiapp_second']);
  assert.equal((await store.connection()).accountId, first);
  assert.equal(await store.removeAccount(first), true);
  assert.equal(await store.activeAccountId(), first);
  await assert.rejects(store.connection(), {code: 'invalid_grant'});
  assert.equal((await store.accounts()).length, 2);
});


test('a connection waiting to renew never switches to a different selected account', async () => {
  class SwitchingProvider extends SerializedProvider {
    beforeReturn?: () => Promise<void>;
    async readRecord(key: CredentialKey) {
      const record = await super.readRecord(key);
      const action = this.beforeReturn;
      this.beforeReturn = undefined;
      if (action) await action();
      return record;
    }
  }
  const provider = new SwitchingProvider();
  let refreshed = false;
  const store = new ConnectionStore(provider, '/fixture/racing-accounts', auth({async refresh() {
    refreshed = true;
    return credential();
  }}));
  await store.connect(credential({expiresAt: Date.now() - 1}));
  const first = (await store.activeAccountId())!;
  await store.connect(credential({subject: 'fixture-second', issuedClientId: 'oaiapp_second', accessToken: 'second-access'}));
  const second = (await store.activeAccountId())!;
  await store.switchAccount(first);
  provider.beforeReturn = () => store.switchAccount(second);
  await assert.rejects(store.connection(), /连接已变更/);
  assert.equal(refreshed, false);
  assert.equal((await store.connection()).accessToken, 'second-access');
});

test('a queued account switch preserves renewal in the original account transaction', async () => {
  let markStarted!: () => void;
  let releaseRefresh!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const release = new Promise<void>(resolve => { releaseRefresh = resolve; });
  const store = new ConnectionStore(new SerializedProvider(), '/fixture/queued-switch', auth({async refresh() {
    markStarted();
    await release;
    return credential({accessToken: 'first-renewed'});
  }}));
  await store.connect(credential({expiresAt: Date.now() - 1}));
  const first = (await store.activeAccountId())!;
  await store.connect(credential({subject: 'fixture-second', issuedClientId: 'oaiapp_second', accessToken: 'second-access'}));
  const second = (await store.activeAccountId())!;
  await store.switchAccount(first);
  const pending = store.connection();
  await started;
  const switching = store.switchAccount(second);
  releaseRefresh();
  const resolved = await pending;
  await switching;
  assert.equal(resolved.accountId, first);
  assert.equal(resolved.accessToken, 'first-renewed');
  assert.equal((await store.connection()).accountId, second);
  assert.equal((await store.connection()).accessToken, 'second-access');
  await store.switchAccount(first);
  assert.equal((await store.connection()).accessToken, 'first-renewed');
});

test('v2 accounts enable independent calls once and preserve later opt-out across restart', async () => {
  const provider = new SerializedProvider();
  const path = '/fixture/default-independent';
  const key = credentialKey('chatgpt-siwc', `profile-${createHash('sha256').update(path).digest('hex')}`);
  const store = new ConnectionStore(provider, path, auth());
  await store.connect(credential());
  await provider.modifyRecord(key, async record => {
    assert.ok(record?.kind === 'grant');
    const payload = record.payload as {schemaVersion: number; accounts: {allowBackground: boolean}[]; defaults: {allowBackground: boolean}};
    payload.schemaVersion = 2;
    payload.defaults.allowBackground = false;
    for (const account of payload.accounts) account.allowBackground = false;
    return record;
  });
  assert.equal((await store.read()).allowBackground, true);
  await store.update(state => { state.allowBackground = false; });
  const restarted = new ConnectionStore(provider, path, auth());
  assert.equal((await restarted.read()).allowBackground, false);
  await restarted.connect(credential());
  assert.equal((await restarted.read()).allowBackground, false);
});
