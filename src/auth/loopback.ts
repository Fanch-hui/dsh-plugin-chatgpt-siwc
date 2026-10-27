import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AuthError } from './types.js';

function reply(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    Connection: 'close',
  });
  response.end(message);
}

function validQuery(request: IncomingMessage, redirectUri: string, state: string): URLSearchParams | undefined {
  if (request.method !== 'GET' || request.headers.host !== new URL(redirectUri).host) return;
  const url = new URL(request.url ?? '/', redirectUri);
  if (url.pathname !== '/auth/callback') return;
  const keys = ['state', 'code', 'client_id', 'error'];
  if (keys.some(key => url.searchParams.getAll(key).length > 1)) return;
  const actual = Buffer.from(url.searchParams.get('state') ?? '');
  const expected = Buffer.from(state);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return;
  return url.searchParams;
}

interface LoopbackOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Keeps timeout and cancellation active until token validation has finished. */
export async function startLoopback<T>(
  state: string,
  complete: (query: URLSearchParams, redirectUri: string, signal: AbortSignal) => Promise<T>,
  options: LoopbackOptions,
): Promise<{ redirectUri: string; completion: Promise<T>; cancel(): void }> {
  if (options.signal?.aborted) throw new AuthError('cancelled', '登录操作已取消。');
  const controller = new AbortController();
  let consumed = false;
  let settled = false;
  let resolve!: (value: T) => void;
  let reject!: (error: AuthError) => void;
  const completion = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // The Host may open a browser before attaching its completion handler.
  void completion.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = (error: AuthError) => {
    controller.abort();
    finish(error);
    server.closeAllConnections();
  };
  const externalCancel = () => cancel(new AuthError('cancelled', '登录操作已取消。'));
  const finish = (error?: AuthError, value?: T) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', externalCancel);
    server.close();
    server.closeIdleConnections();
    if (error) reject(error);
    else resolve(value!);
  };
  let redirectUri = 'http://127.0.0.1/auth/callback';
  const server = createServer((request, response) => {
    if (consumed || settled) { reply(response, 409, 'This sign-in attempt has finished.'); return; }
    let query: URLSearchParams | undefined;
    try { query = validQuery(request, redirectUri, state); }
    catch { /* A malformed request is rejected without consuming the attempt. */ }
    if (!query) { reply(response, 400, 'Invalid sign-in callback.'); return; }
    consumed = true;
    const callbackError = query.get('error');
    if (callbackError) {
      reply(response, 400, 'Sign-in was not completed. You can return to DSH.');
      finish(new AuthError(callbackError === 'access_denied' ? 'access_denied' : 'authorization_failed', '登录授权未完成，请在 DSH 中重试。'));
      return;
    }
    void complete(query, redirectUri, controller.signal)
      .then(value => { reply(response, 200, 'ChatGPT is connected. You can return to DSH.'); finish(undefined, value); })
      .catch(error => {
        reply(response, 400, 'Sign-in failed. Return to DSH to try again.');
        finish(error instanceof AuthError ? error : new AuthError('authorization_failed', '登录授权失败，请重试。'));
      });
  });
  await new Promise<void>((yes, no) => {
    server.once('error', () => no(new AuthError('listener_unavailable', '启动本机登录回调失败，请重试。')));
    server.listen(0, '127.0.0.1', () => yes());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new AuthError('listener_unavailable', '启动本机登录回调失败，请重试。');
  }
  redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
  timer = setTimeout(() => cancel(new AuthError('timeout', '登录已超时，请重试。')), options.timeoutMs ?? 300_000);
  timer.unref();
  options.signal?.addEventListener('abort', externalCancel, { once: true });
  if (options.signal?.aborted) externalCancel();
  return { redirectUri, completion, cancel: externalCancel };
}
