import { createLocalJWKSet, jwtVerify, type JWTPayload, type JSONWebKeySet } from 'jose';
import { AuthError, ISSUER, RESOURCE, type Credential, type Registration } from './types.js';

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  revocation_endpoint?: string;
}

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type: string;
  expires_in: number;
  scope?: string;
  earliest_refresh_at?: number | string;
}

type Fetch = typeof globalThis.fetch;

const invalidAuthorizationCodes = new Set([
  'invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired',
  'refresh_token_invalidated', 'refresh_token_reused',
]);

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trustedEndpoint(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.origin === ISSUER && !url.username && !url.password && !url.hash;
  } catch { return false; }
}

export class AuthProtocol {
  constructor(private readonly transport: Fetch = globalThis.fetch) {}

  async discovery(signal?: AbortSignal): Promise<Discovery> {
    const value = await this.json(`${ISSUER}/.well-known/openid-configuration`, { signal });
    if (!object(value) || value.issuer !== ISSUER ||
      !trustedEndpoint(value.authorization_endpoint) || !trustedEndpoint(value.token_endpoint) ||
      !trustedEndpoint(value.jwks_uri) ||
      (value.revocation_endpoint !== undefined && !trustedEndpoint(value.revocation_endpoint))) {
      throw new AuthError('invalid_response', 'OpenAI 的登录配置无效。');
    }
    return value as unknown as Discovery;
  }

  async exchange(fields: Record<string, string>, signal?: AbortSignal): Promise<TokenSet> {
    const discovery = await this.discovery(signal);
    const value = await this.json(discovery.token_endpoint, {
      method: 'POST', signal, body: new URLSearchParams({ ...fields, resource: RESOURCE }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (!object(value) || typeof value.access_token !== 'string' || !value.access_token ||
      typeof value.token_type !== 'string' || value.token_type.toLowerCase() !== 'bearer' ||
      typeof value.expires_in !== 'number' || !Number.isFinite(value.expires_in) || value.expires_in <= 0 ||
      (value.refresh_token !== undefined && (typeof value.refresh_token !== 'string' || !value.refresh_token)) ||
      (value.id_token !== undefined && (typeof value.id_token !== 'string' || !value.id_token)) ||
      (value.scope !== undefined && typeof value.scope !== 'string')) {
      throw new AuthError('invalid_response', 'OpenAI 返回的登录凭据格式无效。');
    }
    return value as unknown as TokenSet;
  }

  async identity(idToken: string, clientId: string, nonce?: string, signal?: AbortSignal): Promise<JWTPayload> {
    try {
      const discovery = await this.discovery(signal);
      const jwks = await this.json(discovery.jwks_uri, { signal });
      if (!object(jwks) || !Array.isArray(jwks.keys)) {
        throw new AuthError('invalid_response', 'OpenAI 的签名密钥格式无效。');
      }
      const { payload } = await jwtVerify(idToken, createLocalJWKSet(jwks as unknown as JSONWebKeySet), {
        issuer: ISSUER, audience: clientId, algorithms: ['RS256', 'ES256'],
        requiredClaims: ['sub', 'exp', 'iat'],
      });
      if (!payload.sub || (nonce !== undefined && payload.nonce !== nonce)) {
        throw new AuthError('invalid_identity', '登录身份校验失败，请重新登录。');
      }
      return payload;
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError('invalid_identity', '登录身份校验失败，请重新登录。');
    }
  }

  async revoke(credential: Credential, signal?: AbortSignal): Promise<void> {
    if (!credential.refreshToken) return;
    const discovery = await this.discovery(signal);
    if (!discovery.revocation_endpoint) {
      throw new AuthError('service_unavailable', 'OpenAI 当前未提供会话撤销地址。');
    }
    await this.request(discovery.revocation_endpoint, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: credential.refreshToken, token_type_hint: 'refresh_token', client_id: credential.issuedClientId }),
    });
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      const timeout = AbortSignal.timeout(30_000);
      const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      response = await this.transport(url, { ...init, signal, redirect: 'error' });
    } catch {
      if (init.signal?.aborted) throw new AuthError('cancelled', '登录操作已取消。');
      throw new AuthError('network_error', '连接 OpenAI 登录服务失败，请重试。');
    }
    if (response.ok) return response;
    let code: unknown;
    try {
      const body: unknown = await response.json();
      if (object(body)) code = object(body.error) ? body.error.code : body.error;
    } catch { /* Error bodies are optional; status remains available. */ }
    if (typeof code === 'string' && invalidAuthorizationCodes.has(code)) {
      throw new AuthError('invalid_grant', '登录授权已失效，请重新登录。', response.status);
    }
    if (response.status >= 500 || [403, 408, 429].includes(response.status)) {
      throw new AuthError('service_unavailable', 'OpenAI 登录服务暂时不可用，请稍后重试。', response.status);
    }
    throw new AuthError('authorization_failed', 'OpenAI 拒绝了登录授权，请重新登录。', response.status);
  }

  private async json(url: string, init: RequestInit): Promise<unknown> {
    const response = await this.request(url, init);
    try { return await response.json(); }
    catch { throw new AuthError('invalid_response', 'OpenAI 登录服务返回了无效数据。'); }
  }
}

export function credentials(
  token: TokenSet, identity: JWTPayload, registration: Registration,
  previous?: Credential,
): Credential {
  const now = Date.now();
  const idToken = token.id_token ?? previous?.idToken;
  const scope = token.scope ?? previous?.grantedScopes.join(' ');
  if (!idToken || scope === undefined) {
    throw new AuthError('invalid_response', 'OpenAI 返回的身份或授权范围缺失。');
  }
  let earliestRefreshAt: number | undefined;
  if (token.earliest_refresh_at !== undefined) {
    earliestRefreshAt = typeof token.earliest_refresh_at === 'number'
      ? token.earliest_refresh_at * 1000 : Date.parse(token.earliest_refresh_at);
    if (!Number.isFinite(earliestRefreshAt)) {
      throw new AuthError('invalid_response', 'OpenAI 返回的续期时间无效。');
    }
  }
  return {
    ...registration, schemaVersion: 1, subject: identity.sub!,
    displayEmail: typeof identity.email === 'string' ? identity.email : registration.displayEmail,
    accessToken: token.access_token, refreshToken: token.refresh_token ?? previous?.refreshToken,
    idToken, grantedScopes: scope.split(/\s+/).filter(Boolean), receivedAt: now,
    expiresAt: now + token.expires_in * 1000, earliestRefreshAt,
  };
}
