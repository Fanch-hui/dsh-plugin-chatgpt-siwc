import { createHash } from 'node:crypto'
import {
  LlmError, offloadedImageText, projectToolUpdates, requestImageHandleText,
  type GenerateOptions, type ContentBlock, type ImageBlock, type ImageAttachmentAccessResolver, type ToolSchema,
} from '@deepseek-ai/dsh-llm'
import {
  analyzeAssistantReplay, assistantReasoningEffort, emptyReplay,
  type ReplayContext, type ReplayDiagnosticReason, type ReplayDiagnosticStats, type WireItem,
} from './replay.js'
import { projectToolCallId, projectTools, toolIdentity, type ToolIdentity } from './tools.js'

export type { ReplayDiagnosticReason, ReplayDiagnosticStats } from './replay.js'
export type ResolveImage = (block: ImageBlock, signal?: AbortSignal) => Promise<string>

export interface CachePolicyView {
  mode?: 'implicit'
  ttl?: '30m' | '12h'
  breakpointVersion?: number
  policyHash: string
}

export interface RequestEnhancements {
  cacheOptions?: {
    mode?: 'implicit'
    ttl?: '30m' | '12h'
    comparisonResponseId?: string
    cacheKey?: string
    breakpointVersion?: number
  }
  toolUpdate?: 'addition-only'
  configurationUpdate?: boolean
  initialReasoningEffort?: string
}

export interface RequestProjection {
  body: WireItem
  identities: ToolIdentity[]
  semanticSettings: WireItem
  cachePolicy: CachePolicyView
  replayStats: ReplayDiagnosticStats
}

function stableHash(value: unknown): string {
  const serialized = JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, (item as Record<string, unknown>)[key]]))
      : item) ?? 'null'
  return createHash('sha256').update(serialized).digest('hex')
}

async function content(
  blocks: readonly ContentBlock[],
  image?: ResolveImage,
  signal?: AbortSignal,
  imageAccess?: ImageAttachmentAccessResolver,
): Promise<WireItem[]> {
  const result: WireItem[] = []
  for (const block of blocks) {
    if (block.type === 'text') result.push({ type: 'input_text', text: block.text })
    else if (block.type === 'image') {
      if (block.offloaded) {
        result.push({ type: 'input_text', text: offloadedImageText(block.attachment, imageAccess?.(block.attachment)) })
        continue
      }
      if (!image) throw new LlmError('DSH 图片附件服务未就绪。', 'SIWC_IMAGE_UNAVAILABLE')
      result.push({ type: 'input_text', text: requestImageHandleText(block.attachment, block.attachment, imageAccess?.(block.attachment)) })
      result.push({ type: 'input_image', image_url: await image(block, signal) })
    } else if (block.type === 'file') {
      throw new LlmError('文件附件必须由 DSH 投影为文本。', 'UNSUPPORTED_CONTENT')
    } else if (!['reasoning', 'tool-call', 'tool-addition', 'tool-removal'].includes(block.type)) {
      throw new LlmError(`不支持的内容类型：${block.type}`, 'UNSUPPORTED_CONTENT')
    }
  }
  return result
}

function resolveToolSet(options: GenerateOptions, enhancements?: RequestEnhancements) {
  const history = options.toolHistory
  if (enhancements?.toolUpdate === 'addition-only' && history) {
    const devIds = new Set(options.messages.flatMap(m => m.role === 'developer' ? [m.id] : []))
    if (history.updates.every(update => devIds.has(update.messageId))) {
      const activeTools = options.tools ?? [
        ...history.tools,
        ...history.updates.flatMap(update => update.additions),
      ]
      const projectedUpdates = projectToolUpdates(options.messages, activeTools, 'addition-only', history)
      const baselineSchemas = (projectedUpdates.tools ?? []).filter(tool => !tool.deferLoading)
      const baselineProjected = projectTools(baselineSchemas)
      const allByName = new Map<string, ToolSchema>()
      for (const schema of [
        ...history.tools,
        ...history.updates.flatMap(update => update.additions),
        ...(projectedUpdates.tools ?? []),
        ...(options.tools ?? []),
      ]) {
        if (!allByName.has(schema.name)) allByName.set(schema.name, schema)
      }
      const allProjected = projectTools([...allByName.values()])
      return {
        messages: projectedUpdates.messages,
        tools: baselineProjected.tools,
        identities: allProjected.identities,
        useToolAdditions: true,
      }
    }
  }
  const projected = projectTools(options.tools)
  return {
    messages: options.messages,
    tools: projected.tools,
    identities: projected.identities,
    useToolAdditions: false,
  }
}

export async function buildRequest(
  options: GenerateOptions,
  context: ReplayContext,
  image?: ResolveImage,
  imageAccess?: ImageAttachmentAccessResolver,
  enhancements?: RequestEnhancements,
): Promise<RequestProjection> {
  // DSH auto-review supplies zero even for providers using server-managed sampling.
  if (options.temperature !== undefined && options.temperature !== 0) {
    throw new LlmError('ChatGPT SIWC 使用服务端采样设置，不支持自定义 temperature。', 'SIWC_UNSUPPORTED_PARAMETER')
  }
  for (const key of ['maxTokens', 'stop'] as const) {
    if (options[key] !== undefined) throw new LlmError(`ChatGPT SIWC 当前不支持 ${key}。`, 'SIWC_UNSUPPORTED_PARAMETER')
  }
  const { messages, tools, identities, useToolAdditions } = resolveToolSet(options, enhancements)
  const input: WireItem[] = []
  let totalBlocks = 0
  let nativeBlocks = 0
  let degradedBlocks = 0
  const reasonSet = new Set<ReplayDiagnosticReason>()
  const firstRecordedEffort = messages.reduce<string | undefined>(
    (found, msg) => found ?? (msg.role === 'assistant' ? assistantReasoningEffort(msg, context) : undefined),
    undefined,
  )
  const baselineEffort = enhancements?.configurationUpdate
    ? (enhancements.initialReasoningEffort ?? firstRecordedEffort ?? options.reasoningEffort)
    : undefined
  let activeEffort = baselineEffort

  for (const message of messages) {
    options.signal?.throwIfAborted()
    if (message.role !== 'user' && message.role !== 'tool' && message.content.some(block => block.type === 'image')) {
      throw new LlmError('ChatGPT SIWC 图片仅支持用户消息和工具结果。', 'UNSUPPORTED_CONTENT')
    }
    if (message.role === 'assistant') {
      const turnEffort = assistantReasoningEffort(message, context)
      if (enhancements?.configurationUpdate && turnEffort && activeEffort && turnEffort !== activeEffort) {
        input.push({ type: 'configuration_update', reasoning: { effort: turnEffort } })
        activeEffort = turnEffort
      }
      const { replay, native, slotMeta, trustedOrder, reordered, reasons } = analyzeAssistantReplay(message, context)
      totalBlocks += message.content.length
      nativeBlocks += native.size
      degradedBlocks += message.content.length - native.size
      for (const reason of reasons) reasonSet.add(reason)

      const projectedItems: { item: WireItem; order: number; partOrder: number; index: number }[] = []
      for (const [i, block] of message.content.entries()) {
        const saved = replay[i]
        const meta = slotMeta[i]
        const original = native.get(i)
        if (original) {
          if (original.index === i) projectedItems.push({ ...original, partOrder: original.partOrder ?? 0 })
          continue
        }
        const effectiveMeta = saved ?? (trustedOrder ? meta : undefined)
        const order = effectiveMeta?.outputIndex ?? i
        const partOrder = effectiveMeta?.partIndex ?? 0
        if (block.type === 'text') {
          const phase = effectiveMeta?.item.phase
          projectedItems.push({
            order, partOrder, index: i,
            item: {
              role: 'assistant',
              content: [{ type: 'output_text', text: block.text, annotations: [] }],
              ...(phase === 'commentary' || phase === 'final_answer' ? { phase } : {}),
            },
          })
        } else if (block.type === 'tool-call') {
          const identity = toolIdentity(block.name)
          projectedItems.push({
            order, partOrder, index: i,
            item: {
              type: 'function_call', call_id: projectToolCallId(block.id),
              name: identity.name, namespace: identity.namespace, arguments: block.arguments,
            },
          })
        }
      }
      if (native.size === message.content.length && !reordered) {
        for (const empty of emptyReplay(message, replay, native)) {
          projectedItems.push({ ...empty, partOrder: empty.partOrder ?? 0 })
        }
      }
      if (trustedOrder || (native.size === message.content.length && !reordered)) {
        projectedItems.sort((a, b) => a.order - b.order || a.partOrder - b.partOrder || a.index - b.index)
      }
      input.push(...projectedItems.map(projection => projection.item))
      continue
    }
    const converted = await content(message.content, image, options.signal, imageAccess)
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: projectToolCallId(message.toolCallId), output: converted })
    } else if (message.role === 'developer' && useToolAdditions && options.toolHistory) {
      if (converted.length) input.push({ role: 'developer', content: converted })
      const addedNames = message.content.flatMap(block => block.type === 'tool-addition' ? [block.toolName] : [])
      if (addedNames.length) {
        const update = options.toolHistory.updates.find(entry => entry.messageId === message.id)
        const addedSchemas = addedNames
          .map(name => update?.additions.find(tool => tool.name === name)
            ?? options.toolHistory!.tools.find(tool => tool.name === name)
            ?? options.tools?.find(tool => tool.name === name))
          .filter((tool): tool is ToolSchema => tool !== undefined)
        if (addedSchemas.length) {
          input.push({ type: 'additional_tools', role: 'developer', tools: projectTools(addedSchemas).tools })
        }
      }
    } else if (converted.length) {
      input.push({ role: message.role === 'system' ? 'developer' : message.role, content: converted })
    }
  }

  const body: WireItem = {
    model: options.model,
    input,
    tools,
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
  }
  if (options.system) body.instructions = options.system
  if (enhancements?.configurationUpdate && baselineEffort) {
    body.reasoning = { effort: baselineEffort, summary: 'auto' }
    if (options.reasoningEffort && options.reasoningEffort !== activeEffort) {
      input.push({ type: 'configuration_update', reasoning: { effort: options.reasoningEffort } })
      activeEffort = options.reasoningEffort
    }
  } else if (options.reasoningEffort) {
    body.reasoning = { effort: options.reasoningEffort, summary: 'auto' }
  }

  const cacheOpts = enhancements?.cacheOptions
  if (cacheOpts?.cacheKey) body.prompt_cache_key = cacheOpts.cacheKey
  if (cacheOpts && (cacheOpts.mode || cacheOpts.ttl || cacheOpts.comparisonResponseId)) {
    body.prompt_cache_options = {
      ...(cacheOpts.mode ? { mode: cacheOpts.mode } : {}),
      ...(cacheOpts.ttl ? { ttl: cacheOpts.ttl } : {}),
      ...(cacheOpts.comparisonResponseId ? { comparison_response_id: cacheOpts.comparisonResponseId } : {}),
    }
  }

  const policyBase = {
    ...(cacheOpts?.mode ? { mode: cacheOpts.mode } : {}),
    ...(cacheOpts?.ttl ? { ttl: cacheOpts.ttl } : {}),
    ...(cacheOpts?.breakpointVersion !== undefined ? { breakpointVersion: cacheOpts.breakpointVersion } : {}),
  }
  const cachePolicy: CachePolicyView = { ...policyBase, policyHash: stableHash(policyBase) }
  const {
    input: _input,
    stream: _stream,
    background: _background,
    store: _store,
    previous_response_id: _prev,
    prompt_cache_options: rawPromptCacheOptions,
    ...restSettings
  } = body
  const semanticSettings: WireItem = { ...restSettings }
  if (rawPromptCacheOptions && typeof rawPromptCacheOptions === 'object') {
    const { comparison_response_id: _cmp, ...semanticCacheOpts } = rawPromptCacheOptions as WireItem
    if (Object.keys(semanticCacheOpts).length > 0) {
      semanticSettings.prompt_cache_options = semanticCacheOpts
    }
  }

  return {
    body,
    identities,
    semanticSettings,
    cachePolicy,
    replayStats: {
      totalBlocks,
      nativeBlocks,
      degradedBlocks,
      reasons: [...reasonSet],
    },
  }
}
