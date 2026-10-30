import { isEmptyMessage, type WireItem } from './replay.js'

export type WireEventCategory =
  | 'delta'
  | 'reasoning-summary-done'
  | 'item-added'
  | 'item-done'
  | 'completed'
  | 'incomplete'
  | 'failed'
  | 'status'

export interface WireEventClassification {
  category: WireEventCategory
  emitsOutput: boolean
  terminal: boolean
}

export function reasoningSummaryText(item: WireItem): string {
  if (!Array.isArray(item.summary)) return ''
  return (item.summary as WireItem[])
    .map(part => (typeof part?.text === 'string' ? part.text : ''))
    .filter(text => text.length > 0)
    .join('\n\n')
}

function itemHasOutput(item: WireItem | undefined): boolean {
  if (!item) return true
  if (item.type === 'reasoning') return reasoningSummaryText(item).length > 0
  if (item.type === 'message') {
    if (isEmptyMessage(item) || !Array.isArray(item.content)) return false
    return (item.content as WireItem[]).some(part =>
      Boolean(part) && (
        (part.type === 'output_text' && typeof part.text === 'string' && part.text.length > 0) ||
        (part.type === 'refusal' && typeof part.refusal === 'string' && part.refusal.length > 0)
      ))
  }
  return true
}

/** Shared between transport retry boundaries and stream block materialization. */
export function classifyWireEvent(event: Record<string, unknown>): WireEventClassification {
  const type = String(event.type)
  if (
    type === 'response.output_text.delta' ||
    type === 'response.refusal.delta' ||
    type === 'response.reasoning_summary_text.delta' ||
    type === 'response.function_call_arguments.delta'
  ) {
    return {
      category: 'delta',
      emitsOutput: typeof event.delta === 'string' && event.delta.length > 0,
      terminal: false,
    }
  }
  if (type === 'response.reasoning_summary_text.done' || type === 'response.reasoning_summary_part.done') {
    const text = type === 'response.reasoning_summary_text.done'
      ? event.text
      : (event.part as WireItem | undefined)?.text
    return { category: 'reasoning-summary-done', emitsOutput: typeof text === 'string' && text.length > 0, terminal: false }
  }
  if (type === 'response.output_item.added') {
    const item = event.item as WireItem | undefined
    return { category: 'item-added', emitsOutput: item?.type === 'function_call', terminal: false }
  }
  if (type === 'response.output_item.done') {
    const item = event.item as WireItem | undefined
    return { category: 'item-done', emitsOutput: itemHasOutput(item), terminal: false }
  }
  if (type === 'response.completed') {
    return { category: 'completed', emitsOutput: true, terminal: true }
  }
  if (type === 'response.incomplete') {
    return { category: 'incomplete', emitsOutput: true, terminal: true }
  }
  if (type === 'response.failed' || type === 'error') {
    return { category: 'failed', emitsOutput: false, terminal: true }
  }
  return { category: 'status', emitsOutput: false, terminal: false }
}
