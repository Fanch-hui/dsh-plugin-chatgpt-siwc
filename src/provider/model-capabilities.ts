import {
  ReasoningEffortId,
  type LlmModelReasoningInfo,
  type LlmResolvedModelInfo,
  type ModelModality,
} from '@deepseek-ai/dsh-llm'

export interface CatalogModel extends LlmResolvedModelInfo {
  /** The account's maximum capacity, separate from its normal context budget. */
  maxContextWindow?: number
  /** Preserved even when the account omits its selectable effort list. */
  defaultReasoningEffort?: ReasoningEffortId
  /** A partial capability declaration when no complete modality list exists. */
  imageInput?: boolean
}

type ModelRecord = Record<string, unknown>

export function record(value: unknown): ModelRecord | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return
  return value as ModelRecord
}

function label(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value === value.trim() ? value : undefined
}

function capacity(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function first<T>(values: unknown[], parse: (value: unknown) => T | undefined): T | undefined {
  for (const value of values) {
    const parsed = parse(value)
    if (parsed !== undefined) return parsed
  }
}

function effortList(value: unknown): LlmModelReasoningInfo['efforts'] | undefined {
  if (!Array.isArray(value)) return
  const result: { id: ReasoningEffortId; name: string; description?: string }[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    const item = record(entry)
    const id = label(typeof entry === 'string' ? entry : item?.effort ?? item?.reasoning_effort ?? item?.reasoningEffort)
    if (!id) return
    if (seen.has(id)) continue
    seen.add(id)
    result.push({ id: ReasoningEffortId(id),
      name: label(item?.display_name ?? item?.displayName ?? item?.name) ?? id,
      ...(label(item?.description) ? { description: label(item?.description) } : {}),
    })
  }
  return result
}

function modalities(value: unknown): ModelModality[] | undefined {
  if (!Array.isArray(value) || !value.every(item => label(item) !== undefined)) return
  return [...new Set(value.filter((item): item is ModelModality => item === 'text' || item === 'image'))]
}

export function modelCapabilities(model: ModelRecord): Omit<CatalogModel, 'provider' | 'id' | 'name'> {
  const window = first([model.context_window, model.contextWindow], capacity)
  const maximum = first([model.max_context_window, model.maxContextWindow], capacity)
  const reasoning = record(model.reasoning)
  const effort = record(model.effort)
  const efforts = first([
    model.supported_reasoning_levels, model.supported_reasoning_efforts,
    model.supportedReasoningEfforts, model.reasoning_efforts,
    reasoning?.supported_efforts, effort?.supported_levels,
  ], effortList)
  const declaredDefault = first([
    model.default_reasoning_level, model.default_reasoning_effort, model.defaultReasoningEffort,
  ], label)
  const defaultEffort = declaredDefault && (efforts === undefined || efforts.some(item => item.id === declaredDefault))
    ? ReasoningEffortId(declaredDefault) : undefined
  const inputModalities = first([
    model.input_modalities, model.inputModalities, record(model.modalities)?.input,
  ], modalities)
  const imageInput = inputModalities === undefined
    ? first([model.supports_images, model.supportsImages], value => typeof value === 'boolean' ? value : undefined)
    : inputModalities.includes('image')
  return {
    ...(window === undefined ? {} : { context: { contextWindow: window } }),
    ...(maximum === undefined || window !== undefined && maximum < window ? {} : { maxContextWindow: maximum }),
    ...(efforts === undefined ? {} : { reasoning: { efforts, ...(defaultEffort ? { defaultEffort } : {}) } }),
    ...(defaultEffort ? { defaultReasoningEffort: defaultEffort } : {}),
    ...(inputModalities === undefined ? {} : { inputModalities }),
    ...(imageInput === undefined ? {} : { imageInput }),
  }
}
