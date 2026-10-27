import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ProviderConnection } from './adapter.js'
import type { AttemptBudget } from './transport/types.js'

export async function authenticatedFetch(
  fetcher: typeof fetch,
  renew: (signal?: AbortSignal, rejectedAccessToken?: string) => Promise<ProviderConnection>,
  connectionId: string, input: string | URL | Request, init?: RequestInit,
  budget?: AttemptBudget,
): Promise<Response> {
  const response = await fetcher(input, { ...init, redirect: 'error' })
  if (response.status !== 401) return response
  if (budget && (budget.tokenRefreshesUsed >= budget.maxTokenRefreshes || budget.sendsUsed >= budget.maxSends)) return response
  let error: unknown
  try { error = (await response.clone().json() as { error?: { code?: unknown } }).error?.code }
  catch { return response }
  if (error !== 'token_expired') return response
  if (budget) {
    budget.tokenRefreshesUsed++
    budget.sendsUsed++
    budget.attempt++
  }
  await response.body?.cancel()
  const headers = new Headers(init?.headers)
  const rejected = headers.get('authorization')?.replace(/^Bearer /, '')
  const connection = await renew(init?.signal ?? undefined, rejected)
  if (connection.id !== connectionId) {
    throw new LlmError('ChatGPT 连接已变更，请重新发起请求。', 'SIWC_CONNECTION_CHANGED')
  }
  init?.signal?.throwIfAborted()
  headers.set('authorization', `Bearer ${connection.accessToken}`)
  return fetcher(input, { ...init, headers, redirect: 'error' })
}
