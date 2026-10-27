import { LlmError, ProviderRequestId } from '@deepseek-ai/dsh-llm'

export class ProviderError extends LlmError {
  constructor(
    readonly providerCode: string,
    readonly param?: string,
    status?: number,
    requestId?: string,
    retryAfterMs?: number,
    readonly event?: Record<string, unknown>,
  ) {
    const quota = providerCode === 'subscription_sharing_usage_limit_exceeded'
    const code = quota ? 'QUOTA' : status === 401 ? 'AUTH' : 'SIWC_PROVIDER_ERROR'
    const message = quota
      ? 'ChatGPT 计划用量已达上限，请在 ChatGPT 设置中管理用量。'
      : `ChatGPT 请求失败（${providerCode}${param ? `，字段 ${param}` : ''}）。`
    super(message, code, {
      status,
      requestId: requestId ? ProviderRequestId(requestId) : undefined,
      providerRetryAfterMs: retryAfterMs,
    })
  }
}

export function safeIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-zA-Z0-9_.\-[\]]{1,160}$/.test(value) ? value : undefined
}

export function providerError(value: unknown, response?: Response, event?: Record<string, unknown>): ProviderError {
  const body = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const raw = body.error && typeof body.error === 'object'
    ? body.error as Record<string, unknown> : body
  const after = response?.headers.get('retry-after')
  const ms = after && /^\d+(\.\d+)?$/.test(after) ? Number(after) * 1000 : undefined
  return new ProviderError(
    safeIdentifier(raw.code) ?? safeIdentifier(raw.type) ?? 'unknown_error',
    safeIdentifier(raw.param), response?.status,
    safeIdentifier(response?.headers.get('x-request-id')),
    ms && Number.isFinite(ms) && ms <= 86_400_000 ? ms : undefined,
    event,
  )
}

export async function checkResponse(response: Response): Promise<void> {
  if (response.ok) return
  let body: unknown
  try { body = await response.json() } catch { body = {} }
  throw providerError(body, response)
}
