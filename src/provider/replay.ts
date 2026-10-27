import { createHash } from 'node:crypto'
import type { ContentBlock, ReplayEnvelope, AssistantMessage } from '@deepseek-ai/dsh-llm'
import type { ToolIdentity } from './tools.js'

export type WireItem = Record<string, unknown>
export interface EmptyOutput { outputIndex: number; item: WireItem }
export interface ReplayBlock {
  fingerprint: string; item: WireItem; tool?: ToolIdentity; outputIndex?: number; partIndex?: number
  itemFingerprints?: readonly string[]; visiblePartIndices?: readonly number[]
}
export interface ReplayContext {
  connectionId: string; replayScope?: string; legacyConnectionId?: string
  model: string; sessionId?: string; wireSessionId?: string; reasoningEffort?: string
}
export interface NativeItemProjection {
  outputIndex: number; item: WireItem; tool?: ToolIdentity
  visibleParts: readonly { blockIndex: number; partIndex: number; blockFingerprint: string }[]
}
export interface ReplayProjection { item: WireItem; index: number; order: number; partOrder?: number }
export type ReplayDiagnosticReason =
  | 'intact' | 'edited' | 'compacted' | 'reordered' | 'scope-changed' | 'model-changed' | 'missing-metadata'
export interface ReplayDiagnosticStats {
  totalBlocks: number; nativeBlocks: number; degradedBlocks: number; reasons: ReplayDiagnosticReason[]
}

export function fingerprint(block: ContentBlock): string {
  return createHash('sha256').update(JSON.stringify(block)).digest('hex')
}

function isValidMessagePart(part: unknown): part is WireItem {
  if (!part || typeof part !== 'object') return false
  const value = part as WireItem
  return (value.type === 'output_text' && typeof value.text === 'string') || (value.type === 'refusal' && typeof value.refusal === 'string')
}
function partText(part: WireItem): string { return String(part.type === 'refusal' ? part.refusal : part.text) }
export function isEmptyMessage(item: WireItem): boolean {
  return item.type === 'message' && (item.role === undefined || item.role === 'assistant') &&
    Array.isArray(item.content) && item.content.every(part => isValidMessagePart(part) && partText(part) === '')
}

function itemKey(block: ReplayBlock): string | undefined {
  if (Number.isSafeInteger(block.outputIndex) && block.outputIndex! >= 0) return `output:${block.outputIndex}`
  return typeof block.item.id === 'string' && block.item.id ? `id:${block.item.id}` : undefined
}

export function scopeMatches(response: Record<string, unknown>, context: ReplayContext): boolean {
  if (typeof response.replayScope === 'string' && context.replayScope) return response.replayScope === context.replayScope
  if (response.connectionId === context.connectionId) return true
  if (typeof response.connectionId === 'string' && context.legacyConnectionId && response.connectionId === context.legacyConnectionId) return true
  if (typeof response.replayScope === 'string' && response.replayScope === context.connectionId) return true
  if (typeof response.connectionId === 'string' && context.replayScope && response.connectionId === context.replayScope) return true
  return false
}

function resolveGroupPartIndices(groupIndices: readonly number[], blocks: readonly ReplayBlock[]): number[] {
  if (groupIndices.every(i => Number.isSafeInteger(blocks[i].partIndex) && blocks[i].partIndex! >= 0)) {
    return groupIndices.map(i => blocks[i].partIndex!)
  }
  const first = blocks[groupIndices[0]]
  if (first?.item.type === 'message' && Array.isArray(first.item.content)) {
    const nonEmpty = (first.item.content as unknown[]).flatMap((part, idx) =>
      isValidMessagePart(part) && partText(part).length > 0 ? [idx] : [])
    if (nonEmpty.length === groupIndices.length) return nonEmpty
  }
  return groupIndices.map((i, offset) => blocks[i].partIndex ?? offset)
}

export function replayEnvelope(context: ReplayContext, blocks: ReplayBlock[], responseId?: string, emptyItems?: readonly EmptyOutput[]): ReplayEnvelope {
  const groupIndices = new Map<string, number[]>()
  blocks.forEach((block, index) => {
    const key = itemKey(block)
    if (key) groupIndices.set(key, [...(groupIndices.get(key) ?? []), index])
  })
  const groupFingerprints = new Map<string, string[]>()
  const groupPartIndices = new Map<string, number[]>()
  const blockResolvedPart = new Map<number, number>()
  const nativeItems: NativeItemProjection[] = []

  for (const [key, indices] of groupIndices) {
    const fps = indices.map(i => blocks[i].fingerprint)
    const parts = resolveGroupPartIndices(indices, blocks)
    groupFingerprints.set(key, fps)
    groupPartIndices.set(key, parts)
    indices.forEach((blockIndex, offset) => blockResolvedPart.set(blockIndex, parts[offset]))
    const first = blocks[indices[0]]
    nativeItems.push({
      outputIndex: first.outputIndex ?? indices[0], item: first.item, ...(first.tool ? { tool: first.tool } : {}),
      visibleParts: indices.map((blockIndex, offset) => ({ blockIndex, partIndex: parts[offset], blockFingerprint: blocks[blockIndex].fingerprint })),
    })
  }
  const empty = emptyItems?.filter(entry => Number.isSafeInteger(entry.outputIndex) && entry.outputIndex >= 0 && isEmptyMessage(entry.item))
  for (const { outputIndex, item } of empty ?? []) nativeItems.push({ outputIndex, item, visibleParts: [] })
  nativeItems.sort((a, b) => a.outputIndex - b.outputIndex)

  return {
    response: {
      version: 3, projectionVersion: 1, replayScope: context.replayScope ?? context.connectionId,
      connectionId: context.connectionId, model: context.model,
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      ...(context.wireSessionId ? { wireSessionId: context.wireSessionId } : {}),
      ...(context.reasoningEffort ? { reasoningEffort: context.reasoningEffort } : {}),
      ...(responseId ? { responseId } : {}),
      blockFingerprints: blocks.map(block => block.fingerprint),
      ...(empty?.length ? { emptyItems: empty.map(({ outputIndex, item }) => ({ outputIndex, item })) } : {}),
      nativeItems,
    },
    blocks: blocks.map((block, index) => {
      const key = itemKey(block)
      if (!key) return block
      const partIndex = block.partIndex ?? blockResolvedPart.get(index)
      return {
        ...block, ...(partIndex !== undefined ? { partIndex } : {}),
        itemFingerprints: groupFingerprints.get(key), visiblePartIndices: groupPartIndices.get(key),
      }
    }),
  }
}

export function assistantReasoningEffort(message: AssistantMessage, context: ReplayContext): string | undefined {
  if (message.source?.provider !== 'chatgpt-siwc') return undefined
  const response = (message.source.replayState as ReplayEnvelope | undefined)?.response as Record<string, unknown> | undefined
  if (!response || typeof response !== 'object' || ![1, 2, 3].includes(Number(response.version))) return undefined
  if (!scopeMatches(response, context) || response.model !== context.model) return undefined
  return typeof response.reasoningEffort === 'string' && response.reasoningEffort ? response.reasoningEffort : undefined
}

export function retainedReplay(message: AssistantMessage, context: ReplayContext): (ReplayBlock | undefined)[] {
  const envelope = message.source.replayState as ReplayEnvelope | undefined
  if (!envelope || !envelope.response || typeof envelope.response !== 'object') return []
  const response = envelope.response as Record<string, unknown>
  if (![1, 2, 3].includes(Number(response.version)) || !scopeMatches(response, context) || response.model !== context.model) return []
  if (!Array.isArray(envelope.blocks) || envelope.blocks.length !== message.content.length) return []
  return envelope.blocks.map((value, i) => {
    if (!value || typeof value !== 'object') return undefined
    const block = value as ReplayBlock
    if (block.fingerprint !== fingerprint(message.content[i])) return undefined
    return block.item && typeof block.item === 'object' ? block : undefined
  })
}

function sameSequence<T>(actual: readonly T[], expected: readonly T[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index])
}

function validReasoningSummary(summary: unknown): summary is WireItem[] {
  return Array.isArray(summary) && summary.every(part =>
    Boolean(part) && typeof part === 'object' && (part as WireItem).type === 'summary_text' && typeof (part as WireItem).text === 'string')
}

function itemMatchesBlocks(item: WireItem, blocks: readonly ContentBlock[], saved: ReplayBlock): boolean {
  if (item.type === 'message') {
    if (item.role !== 'assistant' || !Array.isArray(item.content)) return false
    const parts = item.content as unknown[]
    if (!parts.every(isValidMessagePart) || !blocks.every(block => block.type === 'text')) return false
    const blockTexts = blocks.map(block => (block as { text: string }).text)
    if (parts.length === blocks.length && (!saved.visiblePartIndices || sameSequence(saved.visiblePartIndices, parts.map((_, i) => i)))) {
      return sameSequence(blockTexts, parts.map(partText))
    }
    if (!saved.itemFingerprints) return false
    const nonEmptyIndices: number[] = []
    const nonEmptyTexts: string[] = []
    parts.forEach((part, index) => {
      const text = partText(part)
      if (text.length > 0) { nonEmptyIndices.push(index); nonEmptyTexts.push(text) }
    })
    if (saved.visiblePartIndices && !sameSequence(saved.visiblePartIndices, nonEmptyIndices)) return false
    return sameSequence(blockTexts, nonEmptyTexts)
  }
  if (blocks.length !== 1) return false
  const block = blocks[0]
  if (item.type === 'reasoning' && block.type === 'reasoning') {
    if (item.summary !== undefined && !validReasoningSummary(item.summary)) return false
    if (!saved.itemFingerprints) {
      return validReasoningSummary(item.summary) && item.summary.map(part => part.text).join('') === block.text
    }
    return saved.fingerprint === fingerprint(block)
  }
  if (item.type !== 'function_call' || block.type !== 'tool-call' || !saved.tool) return false
  return item.call_id === block.id && item.arguments === block.arguments && item.name === saved.tool.name &&
    (item.namespace ?? 'dsh') === saved.tool.namespace && saved.tool.original === block.name
}

/** Complete native items are reused only while every one of their visible blocks remains intact. */
export function nativeReplay(message: AssistantMessage, replay: readonly (ReplayBlock | undefined)[]): Map<number, ReplayProjection> {
  const groups = new Map<string, number[]>()
  replay.forEach((saved, index) => {
    const key = saved && itemKey(saved)
    if (key) groups.set(key, [...(groups.get(key) ?? []), index])
  })
  const result = new Map<number, ReplayProjection>()
  for (const indices of groups.values()) {
    const first = indices[0]
    const saved = replay[first]!
    const members = indices.map(index => replay[index]!)
    if (members.some(member => JSON.stringify(member.item) !== JSON.stringify(saved.item))) continue
    if (saved.itemFingerprints && (!members.every(member => member.itemFingerprints &&
      sameSequence(member.itemFingerprints, saved.itemFingerprints!)) ||
      !sameSequence(members.map(member => member.fingerprint), saved.itemFingerprints))) continue
    if (!itemMatchesBlocks(saved.item, indices.map(index => message.content[index]), saved)) continue
    const projection: ReplayProjection = { item: saved.item, index: first, order: saved.outputIndex ?? first, partOrder: saved.partIndex ?? 0 }
    for (const index of indices) result.set(index, projection)
  }
  return result
}

export function emptyReplay(
  message: AssistantMessage,
  replay: readonly (ReplayBlock | undefined)[],
  native: ReadonlyMap<number, ReplayProjection>,
): ReplayProjection[] {
  if (!message.content.length || native.size !== message.content.length) return []
  const envelope = message.source.replayState as ReplayEnvelope | undefined
  const response = envelope?.response && typeof envelope.response === 'object' ? envelope.response as Record<string, unknown> : undefined
  if (!Array.isArray(response?.blockFingerprints) || !response.blockFingerprints.every((v): v is string => typeof v === 'string')) return []
  if (!sameSequence(replay.map(block => block?.fingerprint ?? ''), response.blockFingerprints)) return []
  const rawEmpty = Array.isArray(response.emptyItems) ? response.emptyItems
    : Array.isArray(response.nativeItems) ? response.nativeItems.filter(e =>
      e && typeof e === 'object' && Array.isArray((e as NativeItemProjection).visibleParts) && (e as NativeItemProjection).visibleParts.length === 0)
      : undefined
  if (!rawEmpty?.length) return []
  const usedIndices = new Set(replay.map(block => block?.outputIndex).filter((index): index is number => index !== undefined))
  const projections: ReplayProjection[] = []
  for (const [offset, raw] of rawEmpty.entries()) {
    if (!raw || typeof raw !== 'object') return []
    const entry = raw as Partial<EmptyOutput>
    if (!Number.isSafeInteger(entry.outputIndex) || entry.outputIndex! < 0 || usedIndices.has(entry.outputIndex!)) return []
    if (!entry.item || typeof entry.item !== 'object' || !isEmptyMessage(entry.item)) return []
    usedIndices.add(entry.outputIndex!)
    projections.push({ item: entry.item, order: entry.outputIndex!, partOrder: 0, index: message.content.length + offset })
  }
  return projections
}

function matchFingerprintSlots(currentFps: readonly string[], candidates: readonly (string | undefined)[]) {
  const used = new Set<number>()
  const slots = new Array<number | undefined>(currentFps.length).fill(undefined)
  currentFps.forEach((fp, i) => {
    if (candidates.length === currentFps.length && candidates[i] === fp && !used.has(i)) { slots[i] = i; used.add(i) }
  })
  currentFps.forEach((fp, i) => {
    if (slots[i] !== undefined) return
    const found = candidates.findIndex((c, idx) => !used.has(idx) && c === fp)
    if (found !== -1) { slots[i] = found; used.add(found) }
  })
  let nonMonotonic = false
  let prev = -1
  for (const s of slots) { if (s !== undefined) { if (s <= prev) { nonMonotonic = true; break } prev = s } }
  return { slots, used, nonMonotonic }
}

export function analyzeAssistantReplay(message: AssistantMessage, context: ReplayContext) {
  const emptyResult = (reason: ReplayDiagnosticReason) => ({
    replay: [] as (ReplayBlock | undefined)[], native: new Map<number, ReplayProjection>(),
    slotMeta: [] as (ReplayBlock | undefined)[], trustedOrder: false, reordered: false, reasons: [reason],
  })
  const envelope = message.source.replayState as ReplayEnvelope | undefined
  const response = envelope?.response && typeof envelope.response === 'object' ? envelope.response as Record<string, unknown> : undefined
  const rawBlocks = Array.isArray(envelope?.blocks) ? envelope.blocks : undefined
  if (!envelope || !response || ![1, 2, 3].includes(Number(response.version)) || !rawBlocks) return emptyResult('missing-metadata')
  if (response.model !== context.model) return emptyResult('model-changed')
  if (!scopeMatches(response, context)) return emptyResult('scope-changed')

  const currentFps = message.content.map(fingerprint)
  const rawFps = rawBlocks.map(b => b && typeof b === 'object' && typeof (b as ReplayBlock).fingerprint === 'string' ? (b as ReplayBlock).fingerprint : undefined)
  const refFps = Array.isArray(response.blockFingerprints) && response.blockFingerprints.every((v): v is string => typeof v === 'string') ? response.blockFingerprints : rawFps
  const refMatch = matchFingerprintSlots(currentFps, refFps)
  const rawMatch = matchFingerprintSlots(currentFps, rawFps)
  const displaced = rawBlocks.length === currentFps.length && rawMatch.slots.some((s, i) => s !== undefined && s !== i)
  const reordered = refMatch.nonMonotonic || rawMatch.nonMonotonic || displaced
  const unmatchedCount = currentFps.length - rawMatch.used.size
  if (!reordered && rawBlocks.length === currentFps.length && unmatchedCount === 1) {
    rawMatch.slots.forEach((s, i) => { if (s === undefined && !rawMatch.used.has(i)) { rawMatch.slots[i] = i; rawMatch.used.add(i) } })
  }
  const slotMeta = rawMatch.slots.map(idx => {
    const val = idx !== undefined ? rawBlocks[idx] : undefined
    return val && typeof val === 'object' && (val as ReplayBlock).item && typeof (val as ReplayBlock).item === 'object' ? val as ReplayBlock : undefined
  })
  const replay = retainedReplay(message, context)
  const native = nativeReplay(message, replay)
  const trustedOrder = !reordered && rawMatch.slots.every(s => s !== undefined) &&
    slotMeta.every(m => m !== undefined && Number.isSafeInteger(m.outputIndex) && m.outputIndex! >= 0)
  // Without trustworthy wire order, merging separated blocks into one native item
  // would move content across the intervening blocks in DSH's current history.
  if (!trustedOrder && (reordered || native.size !== currentFps.length)) {
    const previousIndices = new Map<ReplayProjection, number>()
    const separatedGroups = new Set<ReplayProjection>()
    for (const [index, projection] of native) {
      const previousIndex = previousIndices.get(projection)
      if (previousIndex !== undefined && index !== previousIndex + 1) separatedGroups.add(projection)
      previousIndices.set(projection, index)
    }
    for (const [index, projection] of native) {
      if (separatedGroups.has(projection)) native.delete(index)
    }
  }
  const groupShortened = rawBlocks.some(b => {
    if (!b || typeof b !== 'object' || !Array.isArray((b as ReplayBlock).itemFingerprints)) return false
    const key = itemKey(b as ReplayBlock)
    return Boolean(key) && rawBlocks.filter(o => o && typeof o === 'object' && itemKey(o as ReplayBlock) === key).length < (b as ReplayBlock).itemFingerprints!.length
  })
  const compacted = rawBlocks.length !== currentFps.length || currentFps.length < refFps.length || groupShortened
  const edited = !reordered && ((rawBlocks.length === currentFps.length && currentFps.some((fp, i) => rawFps[i] !== fp)) ||
    (!compacted && native.size < currentFps.length && replay.every(b => b !== undefined)))
  const reasons: ReplayDiagnosticReason[] = []
  if (reordered) reasons.push('reordered')
  if (compacted) reasons.push('compacted')
  if (edited) reasons.push('edited')
  if (native.size === currentFps.length && !compacted && !reordered) reasons.push('intact')
  if (!reasons.length) reasons.push('missing-metadata')
  return { replay, native, slotMeta, trustedOrder, reordered, reasons }
}
