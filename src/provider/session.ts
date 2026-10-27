import { createHash, randomUUID } from 'node:crypto'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { deriveReplayScope } from '../storage/state.js'

export function resolveReplayScope(
  scope: string,
  connection: { id: string; accountId?: string; grantEpoch?: number; replayScope?: string },
): string {
  if (connection.replayScope) return connection.replayScope
  if (connection.accountId) return deriveReplayScope(scope, connection.accountId, connection.grantEpoch ?? 1)
  return connection.id
}

/** Session identity survives process/token renewal and A→B→A switches; independent one-shots never share a lane. */
export function requestSessionId(scope: string, replayScopeOrConnectionId: string, options: GenerateOptions): string {
  return createHash('sha256').update(JSON.stringify([
    'dsh-siwc-session-v1', scope, replayScopeOrConnectionId, options.sessionId ?? randomUUID(),
    options.model, options.purpose ?? 'conversation',
  ])).digest('hex')
}
