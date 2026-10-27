import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { AuthError, ISSUER, SiwcAuth, type Credential, type SignInAttempt } from '../src/auth/index.js';

const clientId = 'oaiapp_fixture';
const hostId = 'urn:uuid:fixture-host';

async function fixture() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const key = { ...await exportJWK(publicKey), kid: 'fixture', alg: 'RS256', use: 'sig' };
  let nonce = '';
  let subject = 'fixture-subject';
  let tokenScope: string | undefined = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
  let failToken = false;
  const requests: { path: string; form: URLSearchParams }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, ISSUER);
    const form = new URLSearchParams(String(init?.body ?? ''));
    requests.push({ path: url.pathname, form });
    if (url.pathname === '/.well-known/openid-configuration') {
      return Response.json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/api/accounts/authorize`,
        token_endpoint: `${ISSUER}/api/accounts/oauth/token`, jwks_uri: `${ISSUER}/jwks`, revocation_endpoint: `${ISSUER}/revoke` });
    }
    if (url.pathname === '/jwks') return Response.json({ keys: [key] });
    if (url.pathname === '/revoke') return new Response('', { status: 200 });
    if (url.pathname !== '/api/accounts/oauth/token') throw new Error('Unexpected fixture URL');
    if (failToken) return Response.json({ error: 'invalid_grant', description: 'fixture-private-material' }, { status: 400 });
    const jwt = await new SignJWT({ nonce, email: 'fixture@example.invalid' })
      .setProtectedHeader({ alg: 'RS256', kid: 'fixture' }).setIssuer(ISSUER).setAudience(clientId)
      .setSubject(subject).setIssuedAt().setExpirationTime('1h').sign(privateKey);
    return Response.json({ token_type: 'Bearer', access_token: 'fixture-access', refresh_token: 'fixture-refresh',
      id_token: jwt, expires_in: 3600, scope: tokenScope, earliest_refresh_at: 1_800_000_000 });
  };
  const auth = new SiwcAuth(transport);
  return {
    auth, requests,
    setNonce(value: string) { nonce = value; },
    setSubject(value: string) { subject = value; },
    setScope(value: string | undefined) { tokenScope = value; },
    failToken() { failToken = true; },
    async begin(registration?: Credential) {
      const attempt = await auth.beginSignIn({ hostId, registration });
      nonce = new URL(attempt.authorizationUrl).searchParams.get('nonce')!;
      return attempt;
    },
  };
}

function callback(attempt: SignInAttempt, overrides: Record<string, string> = {}): URL {
  const authorization = new URL(attempt.authorizationUrl);
  const url = new URL(authorization.searchParams.get('redirect_uri')!);
  url.search = new URLSearchParams({ state: authorization.searchParams.get('state')!, code: 'fixture-code',
    client_id: clientId, ...overrides }).toString();
  return url;
}

async function login(f: Awaited<ReturnType<typeof fixture>>): Promise<Credential> {
  const attempt = await f.begin();
  await fetch(callback(attempt));
  return attempt.completion;
}

test('dynamic registration exchanges issued client ID and the exact loopback/PKCE values', async () => {
  const f = await fixture();
  const attempt = await f.begin();
  const authorization = new URL(attempt.authorizationUrl);
  assert.equal(authorization.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(authorization.searchParams.get('agent_name_hint'), 'DSH ChatGPT SIWC');
  assert.equal(new URL(authorization.searchParams.get('redirect_uri')!).hostname, '127.0.0.1');
  const response = await fetch(callback(attempt));
  assert.equal(response.status, 200);
  const value = await attempt.completion;
  assert.equal(value.issuedClientId, clientId);
  assert.equal(value.subject, 'fixture-subject');
  assert.equal(value.displayEmail, 'fixture@example.invalid');
  assert.equal(value.earliestRefreshAt, 1_800_000_000_000);
  const exchange = f.requests.find(request => request.path.endsWith('/token'))!.form;
  assert.equal(exchange.get('client_id'), clientId);
  assert.equal(exchange.get('redirect_uri'), authorization.searchParams.get('redirect_uri'));
  assert.equal(createHash('sha256').update(exchange.get('code_verifier')!).digest('base64url'), authorization.searchParams.get('code_challenge'));
});

test('invalid state leaves the attempt pending and performs no token exchange', async () => {
  const f = await fixture();
  const attempt = await f.begin();
  assert.equal((await fetch(callback(attempt, { state: 'incorrect' }))).status, 400);
  assert.equal(f.requests.length, 0);
  await fetch(callback(attempt));
  await attempt.completion;
  assert.equal(f.requests.filter(request => request.path.endsWith('/token')).length, 1);
});

test('denied consent ends the attempt without exchanging a code', async () => {
  const f = await fixture();
  const attempt = await f.begin();
  await fetch(callback(attempt, { error: 'access_denied' }));
  await assert.rejects(attempt.completion, { code: 'access_denied' });
  assert.equal(f.requests.length, 0);
});

test('missing issued ID in a new registration is rejected', async () => {
  const f = await fixture();
  const attempt = await f.begin();
  const url = callback(attempt);
  url.searchParams.delete('client_id');
  await fetch(url);
  await assert.rejects(attempt.completion, { code: 'registration_incomplete' });
  assert.equal(f.requests.length, 0);
});

test('returning registration reuses client ID, validates identity, and omits registration hint', async () => {
  const f = await fixture();
  const previous = await login(f);
  const attempt = await f.begin(previous);
  const authorization = new URL(attempt.authorizationUrl);
  assert.equal(authorization.searchParams.get('client_id'), clientId);
  assert.equal(authorization.searchParams.get('agent_name_hint'), null);
  assert.equal(authorization.searchParams.get('id_token_hint'), previous.idToken);
  const url = callback(attempt);
  url.searchParams.delete('client_id');
  await fetch(url);
  assert.equal((await attempt.completion).subject, previous.subject);
  const mismatch = await f.begin(previous);
  await fetch(callback(mismatch, { client_id: 'oaiapp_other' }));
  await assert.rejects(mismatch.completion, { code: 'invalid_identity' });
});

test('signed token with the wrong nonce or returning subject is rejected', async () => {
  const f = await fixture();
  const attempt = await f.begin();
  f.setNonce('other-nonce');
  await fetch(callback(attempt));
  await assert.rejects(attempt.completion, { code: 'invalid_identity' });
  const previous = await login(f);
  const returning = await f.begin(previous);
  f.setSubject('other-subject');
  await fetch(callback(returning));
  await assert.rejects(returning.completion, { code: 'invalid_identity' });
});

test('identity sign-in retains granted scopes without assuming plan authorization', async () => {
  const f = await fixture();
  f.setScope('openid profile email');
  const value = await login(f);
  assert.deepEqual(value.grantedScopes, ['openid', 'profile', 'email']);
});

test('refresh rotates credentials, retains omitted scopes and uses issued ID without scope', async () => {
  const f = await fixture();
  const previous = await login(f);
  f.setScope(undefined);
  const next = await f.auth.refresh(previous);
  assert.deepEqual(next.grantedScopes, previous.grantedScopes);
  assert.equal(next.refreshToken, 'fixture-refresh');
  const refresh = f.requests.filter(request => request.path.endsWith('/token')).at(-1)!.form;
  assert.equal(refresh.get('grant_type'), 'refresh_token');
  assert.equal(refresh.get('client_id'), clientId);
  assert.equal(refresh.has('scope'), false);
  await f.auth.revoke(next);
  assert.equal(f.requests.at(-1)?.path, '/revoke');
  assert.equal(f.requests.at(-1)?.form.get('token_type_hint'), 'refresh_token');
});

test('endpoint errors expose safe codes without response details', async () => {
  const f = await fixture();
  const value = await login(f);
  f.failToken();
  await assert.rejects(f.auth.refresh(value), error => {
    assert.ok(error instanceof AuthError);
    assert.equal(error.code, 'invalid_grant');
    assert.equal(error.message.includes('fixture-private-material'), false);
    return true;
  });
});

test('cancel and timeout reject completion and release the local listener', async () => {
  const auth = new SiwcAuth();
  const cancelled = await auth.beginSignIn({ hostId });
  cancelled.cancel();
  await assert.rejects(cancelled.completion, { code: 'cancelled' });
  await assert.rejects(fetch(callback(cancelled)));
  const timedOut = await auth.beginSignIn({ hostId, timeoutMs: 10 });
  await assert.rejects(timedOut.completion, { code: 'timeout' });
  await assert.rejects(fetch(callback(timedOut)));
});
