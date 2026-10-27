import { LlmError, ToolCallId, type ContentBlock, type StreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm'
import { classifyWireEvent, reasoningSummaryText } from './events.js'
import { fingerprint, isEmptyMessage, replayEnvelope, type EmptyOutput, type ReplayBlock, type ReplayContext, type WireItem } from './replay.js'
import { resolveTool, type ToolIdentity } from './tools.js'
import { providerError } from './errors.js'
import { readEvents } from './sse.js'

interface ActiveBlock {
  index: number
  key: string
  output: number
  part: number
  block: ContentBlock
  item: WireItem
  closed: boolean
  tool?: ToolIdentity
}

export function parseUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  const input = value.input_tokens
  const output = value.output_tokens
  if (typeof input !== 'number' || typeof output !== 'number' || !Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return undefined
  const details = value.input_tokens_details as Record<string, unknown> | undefined
  const cached = details?.cached_tokens !== undefined ? details.cached_tokens : undefined
  if (cached !== undefined && (typeof cached !== 'number' || !Number.isFinite(cached) || !Number.isSafeInteger(cached) || cached < 0 || cached > input)) return undefined
  const cacheWrite = details?.cache_write_tokens !== undefined ? details.cache_write_tokens : undefined
  if (cacheWrite !== undefined && (typeof cacheWrite !== 'number' || !Number.isFinite(cacheWrite) || !Number.isSafeInteger(cacheWrite) || cacheWrite < 0 || (cached ?? 0) + cacheWrite > input)) return undefined
  const reasoning = (value.output_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens
  const usage: TokenUsage = {
    inputTokens: input - (cached ?? 0) - (cacheWrite ?? 0),
    outputTokens: output,
    ...(cached === undefined ? {} : { cacheReadTokens: cached }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
  }
  if (typeof value.total_tokens === 'number' && value.total_tokens === input + output) usage.totalTokens = value.total_tokens
  if (typeof reasoning === 'number' && Number.isFinite(reasoning) && reasoning >= 0) usage.reasoningTokens = reasoning
  return usage
}

export async function* parseStream(
  response: Response,
  identities: readonly ToolIdentity[],
  context: ReplayContext,
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  if (!response.body) throw new LlmError('ChatGPT 响应缺少流。', 'SIWC_INVALID_STREAM')
  yield* parseEvents(readEvents(response.body, signal), identities, context, signal, response)
}

export async function* parseEvents(
  events: AsyncIterable<Record<string, unknown>>,
  identities: readonly ToolIdentity[],
  context: ReplayContext,
  signal?: AbortSignal,
  response?: Response,
): AsyncGenerator<StreamChunk> {
  const blocks: ActiveBlock[] = []
  const items = new Map<number, WireItem>()
  const completedReasoning = new Set<number>()
  let completed = false
  const open = (output: number, kind: 'text' | 'reasoning' | 'tool-call', part = 0): [ActiveBlock, StreamChunk[]] => {
    const normalizedPart = kind === 'reasoning' ? 0 : part
    const key = `${output}:${kind}:${normalizedPart}`
    const existing = blocks.find(block => block.key === key)
    if (existing) return [existing, []]
    const item = items.get(output) ?? {}
    let content: ContentBlock
    let tool: ToolIdentity | undefined
    if (kind === 'tool-call') {
      if (typeof item.name !== 'string' || typeof item.call_id !== 'string') {
        throw new LlmError('ChatGPT 工具调用缺少标识。', 'SIWC_INVALID_STREAM')
      }
      tool = resolveTool(identities, item.name, typeof item.namespace === 'string' ? item.namespace : undefined)
      content = { type: 'tool-call', id: ToolCallId(item.call_id), name: tool.original, arguments: '' }
    } else content = { type: kind, text: '' }
    const block: ActiveBlock = { index: blocks.length, key, output, part: normalizedPart, block: content, item, closed: false, tool }
    blocks.push(block)
    return [block, [{ type: 'block-start', index: block.index, blockType: content.type }]]
  }
  const close = (block: ActiveBlock): StreamChunk[] => {
    if (block.closed) return []
    block.closed = true
    return [{ type: 'block-end', index: block.index, block: block.block }]
  }
  const flushReasoning = (beforeOutput: number): StreamChunk[] => {
    const chunks: StreamChunk[] = []
    for (const index of [...completedReasoning].sort((a, b) => a - b)) {
      if (index >= beforeOutput) continue
      completedReasoning.delete(index)
      const item = items.get(index)
      if (!item || item.type !== 'reasoning') continue
      const [block, start] = open(index, 'reasoning')
      chunks.push(...start)
      block.item = item
      chunks.push(...close(block))
    }
    return chunks
  }
  const delta = (block: ActiveBlock, text: string): StreamChunk => {
    if (block.closed) throw new LlmError('ChatGPT 已结束的内容块收到增量。', 'SIWC_INVALID_STREAM')
    if (block.block.type === 'tool-call') {
      block.block.arguments += text
      return { type: 'tool-call-delta', index: block.index, id: block.block.id, name: block.block.name, argumentsDelta: text }
    }
    if (block.block.type !== 'text' && block.block.type !== 'reasoning') throw new LlmError('流块类型错误。', 'SIWC_INVALID_STREAM')
    block.block.text += text
    return { type: block.block.type === 'text' ? 'text-delta' : 'reasoning-delta', index: block.index, text }
  }
  const finalizeItem = (output: number, item: WireItem, fromCompleted = false): StreamChunk[] => {
    const chunks: StreamChunk[] = []
    if (!['message', 'function_call', 'reasoning'].includes(String(item.type))) {
      throw new LlmError('ChatGPT 返回了未支持的输出类型。', 'SIWC_UNSUPPORTED_OUTPUT')
    }
    items.set(output, item)
    if (item.type !== 'reasoning') completedReasoning.delete(output)
    if (item.type === 'function_call') {
      chunks.push(...flushReasoning(output))
      const [block, start] = open(output, 'tool-call')
      chunks.push(...start)
      if (!block.closed && block.block.type === 'tool-call' && block.block.arguments === '' && typeof item.arguments === 'string' && item.arguments.length > 0) {
        chunks.push(delta(block, item.arguments))
      }
      if (block.block.type === 'tool-call' && block.block.arguments !== item.arguments) {
        throw new LlmError('ChatGPT 工具参数与流式结果不一致。', 'SIWC_INVALID_STREAM')
      }
    } else if (item.type === 'message' && Array.isArray(item.content)) {
      for (const [part, value] of (item.content as WireItem[]).entries()) {
        if (value.type !== 'output_text' && value.type !== 'refusal') continue
        const final = value.type === 'refusal' ? value.refusal : value.text
        const existing = blocks.find(block => block.key === `${output}:text:${part}`)
        if (!existing && (typeof final !== 'string' || final.length === 0)) continue
        chunks.push(...flushReasoning(output))
        const [block, start] = open(output, 'text', part)
        chunks.push(...start)
        if (!block.closed && block.block.type === 'text' && block.block.text === '' && typeof final === 'string' && final.length > 0) {
          chunks.push(delta(block, final))
        }
        if (block.block.type === 'text' && block.block.text !== final) {
          throw new LlmError('ChatGPT 文本与流式结果不一致。', 'SIWC_INVALID_STREAM')
        }
      }
    } else if (item.type === 'reasoning') {
      const summary = reasoningSummaryText(item)
      const existing = blocks.find(block => block.key === `${output}:reasoning:0`)
      if (fromCompleted || existing || summary) {
        completedReasoning.delete(output)
        chunks.push(...flushReasoning(output))
        const [block, start] = open(output, 'reasoning')
        chunks.push(...start)
        if (!block.closed && block.block.type === 'reasoning' && block.block.text === '' && summary) chunks.push(delta(block, summary))
      } else {
        completedReasoning.add(output)
      }
    }
    for (const block of blocks.filter(block => block.output === output)) {
      block.item = item
      chunks.push(...close(block))
    }
    return chunks
  }
  try {
    for await (const event of events) {
      signal?.throwIfAborted()
      const type = event.type
      const classification = classifyWireEvent(event)
      const output = typeof event.output_index === 'number' ? event.output_index : -1
      const part = typeof event.content_index === 'number' ? event.content_index : 0
      if (type === 'response.created' && !blocks.length) {
        items.clear()
        completedReasoning.clear()
      } else if (classification.category === 'item-added') {
        if (output === 0 && !blocks.length) {
          items.clear()
          completedReasoning.clear()
        }
        const item = event.item as WireItem
        items.set(output, item)
        if (item?.type !== 'reasoning') completedReasoning.delete(output)
        if (classification.emitsOutput) {
          yield* flushReasoning(output)
          yield* open(output, 'tool-call')[1]
        }
      } else if (classification.category === 'delta') {
        if (!classification.emitsOutput) continue
        const kind = type === 'response.function_call_arguments.delta' ? 'tool-call'
          : type === 'response.reasoning_summary_text.delta' ? 'reasoning' : 'text'
        yield* flushReasoning(output)
        const [block, start] = open(output, kind, part)
        yield* start
        yield delta(block, event.delta as string)
      } else if (classification.category === 'item-done') {
        yield* finalizeItem(output, event.item as WireItem)
      } else if (classification.category === 'failed') {
        const usage = parseUsage((event.response as WireItem | undefined)?.usage ?? event.usage)
        if (usage) yield { type: 'usage', usage }
        throw providerError(type === 'error' ? event : (event.response as WireItem)?.error, response)
      } else if (classification.category === 'incomplete') {
        const usage = parseUsage((event.response as WireItem | undefined)?.usage ?? event.usage)
        if (usage) yield { type: 'usage', usage }
        throw new LlmError('ChatGPT 响应未完整结束。', 'SIWC_INCOMPLETE')
      } else if (classification.category === 'completed') {
        const result = event.response as WireItem
        if (result.status !== undefined && result.status !== 'completed') {
          throw new LlmError('ChatGPT 响应终态无效。', 'SIWC_INVALID_STREAM')
        }
        completedReasoning.clear()
        const emptyOutputs: EmptyOutput[] = []
        if (Array.isArray(result.output)) {
          for (const [index, item] of (result.output as WireItem[]).entries()) {
            yield* finalizeItem(index, item, true)
            if (isEmptyMessage(item) && !blocks.some(block => block.output === index)) {
              emptyOutputs.push({ outputIndex: index, item })
            }
          }
        }
        for (const block of blocks) yield* close(block)
        const usage = parseUsage(result.usage)
        if (usage) yield { type: 'usage', usage }
        const metadata: ReplayBlock[] = blocks.map(block => ({
          fingerprint: fingerprint(block.block), item: block.item, outputIndex: block.output, partIndex: block.part,
          ...(block.tool ? { tool: block.tool } : {}),
        }))
        if (!blocks.length) throw new LlmError('ChatGPT 返回了空响应。', 'EMPTY_RESPONSE')
        const effort = context.reasoningEffort ?? (typeof (result.reasoning as WireItem | undefined)?.effort === 'string' ? (result.reasoning as WireItem).effort as string : undefined)
        yield { type: 'finish', reason: { kind: blocks.some(block => block.block.type === 'tool-call') ? 'tool-calls' : 'stop' },
          replayState: replayEnvelope(effort ? { ...context, reasoningEffort: effort } : context, metadata, typeof result.id === 'string' ? result.id : undefined, emptyOutputs) }
        completed = true
        return
      }
    }
    signal?.throwIfAborted()
    throw new LlmError('ChatGPT 响应流在完成前中断。', 'SIWC_STREAM_INTERRUPTED')
  } catch (error) {
    for (const block of blocks) yield* close(block)
    throw error
  } finally {
    if (!completed) signal?.throwIfAborted()
  }
}
