import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AuthProtocol, credentials } from './protocol.js';
import { startLoopback } from './loopback.js';
import { AuthError, ISSUER, RESOURCE, SCOPES, type Credential, type SignInOptions, type SignInAttempt } from './types.js';

export * from './types.js';

export class SiwcAuth {
  private readonly protocol: AuthProtocol;

  constructor(transport: typeof globalThis.fetch = globalThis.fetch) {
    this.protocol = new AuthProtocol(transport);
  }

  async beginSignIn(options: SignInOptions): Promise<SignInAttempt> {
    if (!options.hostId || (options.registration &&
      (options.registration.issuer !== ISSUER || options.registration.hostId !== options.hostId ||
      !options.registration.issuedClientId || options.registration.issuedClientId === 'dynamic_agent_client'))) {
      throw new AuthError('invalid_identity', '保存的登录注册信息无效。');
    }
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const listener = await startLoopback(state, (query, redirectUri, signal) =>
      this.complete(query, options, { nonce, verifier, redirectUri, signal }), options);
    const url = new URL(`${ISSUER}/api/accounts/authorize`);
    url.search = new URLSearchParams({
      client_id: options.registration?.issuedClientId ?? 'dynamic_agent_client',
      ext_agent_host_id: options.hostId, response_type: 'code', redirect_uri: listener.redirectUri,
      scope: SCOPES, resource: RESOURCE, state, nonce,
      code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    }).toString();
    if (!options.registration) url.searchParams.set('agent_name_hint', 'DSH ChatGPT SIWC');
    if (options.registration?.idToken) url.searchParams.set('id_token_hint', options.registration.idToken);
    if (options.registration?.displayEmail) url.searchParams.set('login_hint', options.registration.displayEmail);
    return { attemptId: randomUUID(), authorizationUrl: url.toString(), completion: listener.completion, cancel: listener.cancel };
  }

  async refresh(credential: Credential, signal?: AbortSignal): Promise<Credential> {
    if (!credential.refreshToken) throw new AuthError('refresh_unavailable', '请重新登录以续期 ChatGPT 连接。');
    const token = await this.protocol.exchange({ grant_type: 'refresh_token',
      client_id: credential.issuedClientId, refresh_token: credential.refreshToken }, signal);
    if (!token.refresh_token) throw new AuthError('invalid_response', 'OpenAI 未返回替换续期凭据。');
    const identity = token.id_token
      ? await this.protocol.identity(token.id_token, credential.issuedClientId, undefined, signal)
      : { sub: credential.subject };
    if (identity.sub !== credential.subject) throw new AuthError('invalid_identity', '续期返回的账号与当前连接不一致，请重新登录。');
    return credentials(token, identity, credential, credential);
  }

  revoke(credential: Credential, signal?: AbortSignal): Promise<void> {
    return this.protocol.revoke(credential, signal);
  }

  private async complete(
    query: URLSearchParams, options: SignInOptions,
    attempt: { nonce: string; verifier: string; redirectUri: string; signal: AbortSignal },
  ): Promise<Credential> {
    const code = query.get('code');
    const suppliedId = query.get('client_id');
    const issuedClientId = suppliedId ?? options.registration?.issuedClientId;
    if (!code || !issuedClientId || issuedClientId === 'dynamic_agent_client') {
      throw new AuthError('registration_incomplete', '登录注册信息缺失，请重试。');
    }
    if (options.registration && issuedClientId !== options.registration.issuedClientId) {
      throw new AuthError('invalid_identity', '登录返回的注册身份与选择的连接不一致。');
    }
    const token = await this.protocol.exchange({ grant_type: 'authorization_code', client_id: issuedClientId,
      code, code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri }, attempt.signal)
      .catch(error => {
        if (error instanceof AuthError && error.code === 'invalid_grant') {
          throw new AuthError(error.code, error.message, error.status, issuedClientId);
        }
        throw error;
      });
    if (!token.id_token) throw new AuthError('invalid_identity', '登录返回的身份凭据缺失。');
    const identity = await this.protocol.identity(token.id_token, issuedClientId, attempt.nonce, attempt.signal);
    if (options.registration && identity.sub !== options.registration.subject) {
      throw new AuthError('invalid_identity', '登录返回的账号与选择的连接不一致。');
    }
    return credentials(token, identity, { issuer: ISSUER, subject: identity.sub!, issuedClientId, hostId: options.hostId });
  }
}
