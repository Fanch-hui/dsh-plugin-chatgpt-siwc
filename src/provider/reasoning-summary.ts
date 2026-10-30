import type { WireItem } from './replay.js'

interface SummaryPart {
  text: string
  completed: boolean
}

export class ReasoningSummary {
  private readonly parts = new Map<number, SummaryPart>()

  append(index: number, text: string): void {
    const part = this.parts.get(index) ?? { text: '', completed: false }
    part.text += text
    this.parts.set(index, part)
  }

  complete(index: number, text: string): void {
    if (!text) return
    const part = this.parts.get(index) ?? { text: '', completed: false }
    // Preserve a longer streamed part when the snapshot contains only its prefix.
    if (!part.text.startsWith(text)) part.text = text
    part.completed = true
    this.parts.set(index, part)
  }

  completeFromItem(item: WireItem): void {
    if (!Array.isArray(item.summary)) return
    for (const [index, value] of item.summary.entries()) {
      const final = (value as WireItem | undefined)?.text
      if (typeof final !== 'string' || !final) continue
      const part = this.parts.get(index)
      if (!part) this.parts.set(index, { text: final, completed: false })
      else if (!part.completed && final.startsWith(part.text)) part.text = final
    }
  }

  get text(): string {
    return [...this.parts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, part]) => part.text)
      .filter(text => text.length > 0)
      .join('\n\n')
  }
}
