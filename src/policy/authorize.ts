import { LlmError, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { StoredState } from '../storage/state.js'

export interface SessionLineage { origin?: string; parentSession?: string }
export function authorizeCall(state: StoredState, options: GenerateOptions): void {
  if (options.sessionId || state.allowBackground) return
  throw new LlmError('请在插件设置中允许独立调用使用 ChatGPT 计划。', 'SIWC_CONSENT_REQUIRED')
}
