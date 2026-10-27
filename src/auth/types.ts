export const ISSUER = 'https://auth.openai.com';
export const RESOURCE = 'https://api.openai.com/v1';
export const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';

export interface Registration {
  issuer: string;
  subject: string;
  issuedClientId: string;
  hostId: string;
  displayEmail?: string;
  idToken?: string;
}

/** Host-only credentials. Never serialize this object into a client response. */
export interface Credential extends Registration {
  schemaVersion: 1;
  accessToken: string;
  refreshToken?: string;
  idToken: string;
  grantedScopes: string[];
  receivedAt: number;
  expiresAt: number;
  earliestRefreshAt?: number;
}

export type AuthErrorCode =
  | 'cancelled' | 'timeout' | 'listener_unavailable' | 'invalid_callback'
  | 'access_denied' | 'authorization_failed' | 'registration_incomplete'
  | 'invalid_identity' | 'invalid_response' | 'invalid_grant'
  | 'network_error' | 'service_unavailable' | 'refresh_unavailable';

export class AuthError extends Error {
  constructor(
    public readonly code: AuthErrorCode,
    message: string,
    public readonly status?: number,
    public readonly issuedClientId?: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface SignInOptions {
  hostId: string;
  registration?: Registration;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SignInAttempt {
  attemptId: string;
  /** Open with the Host's system browser; this URL may contain an ID-token hint. */
  authorizationUrl: string;
  completion: Promise<Credential>;
  cancel(): void;
}
