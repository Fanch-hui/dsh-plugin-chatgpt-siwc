import type { GenerateOptions, Message, RequestMessage } from '@deepseek-ai/dsh-llm'
import type { SessionStore } from '@deepseek-ai/dsh-session'
import { scopeMatches, type ReplayContext } from './replay.js'

const serializedObjects = new WeakMap<object, string>()

function memoizedJson(value: unknown): string {
  if (value && typeof value === 'object') {
    const cached = serializedObjects.get(value)
    if (cached !== undefined) return cached
    const serialized = JSON.stringify(value)
    serializedObjects.set(value, serialized)
    return serialized
  }
  return JSON.stringify(value)
}

function responseId(message: RequestMessage, context: ReplayContext): string | undefined {
  if (message.role !== 'assistant') return
  const envelope = message.source.replayState as { response?: Record<string, unknown> } | undefined
  const value = envelope?.response
  if (!value || typeof value !== 'object') return
  if (value.version !== undefined && ![2, 3].includes(Number(value.version))) return
  if (!scopeMatches(value, context) || value.model !== context.model) return
  const messageSession = value.wireSessionId ?? value.sessionId
  const contextSession = context.wireSessionId ?? context.sessionId
  if (messageSession !== contextSession) return
  return typeof value.responseId === 'string' ? value.responseId : undefined
}

export interface DurabilityDiagnostic {
  reason: 'no-candidate' | 'session-missing' | 'flush-failed' | 'history-mismatch' | 'confirmed' | 'error'
  candidates: number
  confirmed: number
}

/** A returned ID is backed by the current DSH surface AND a completed durability barrier. */
export async function confirmedResponses(
  store: Pick<SessionStore, 'get' | 'flush'>,
  options: GenerateOptions,
  context: ReplayContext,
  observe?: (value: DurabilityDiagnostic) => void,
  candidateResponseIds?: ReadonlySet<string>,
): Promise<ReadonlySet<string>> {
  const candidates = options.messages.filter((message): message is Message => {
    if (message.role !== 'assistant') return false
    const id = responseId(message, context)
    return id !== undefined && (!candidateResponseIds || candidateResponseIds.has(id))
  })
  const result = new Set<string>()
  const finish = (reason: DurabilityDiagnostic['reason']) => {
    try { observe?.({ reason, candidates: candidates.length, confirmed: result.size }) } catch { /* Observation is independent of persistence. */ }
    return result
  }
  if (!options.sessionId || candidates.length === 0) return finish('no-candidate')
  const session = store.get(options.sessionId)
  if (!session) return finish('session-missing')
  options.signal?.throwIfAborted()
  try {
    if (!await store.flush(session)) return finish('flush-failed')
  } catch (error) { finish('error'); throw error }
  options.signal?.throwIfAborted()
  const surface = new Map(session.deriveMessages().map(message => [message.id, message]))
  for (const message of candidates) {
    const durable = surface.get(message.id)
    if (durable?.role !== 'assistant' || message.role !== 'assistant') continue
    if (memoizedJson(durable.content) !== memoizedJson(message.content) ||
      memoizedJson(durable.source) !== memoizedJson(message.source)) continue
    result.add(responseId(message, context)!)
  }
  return finish(result.size === candidates.length ? 'confirmed' : 'history-mismatch')
}
