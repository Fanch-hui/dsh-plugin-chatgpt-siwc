import { LlmError } from '@deepseek-ai/dsh-llm'
import { providerError } from './errors.js'

export async function* readResponseEvents(response: Response, signal?: AbortSignal) {
  if (!response.body) throw new LlmError('ChatGPT 响应缺少流。', 'SIWC_INVALID_STREAM')
  for await (const event of readEvents(response.body, signal)) {
    if (event.type === 'error' || event.type === 'response.failed') {
      const failure = event.type === 'error' ? event : (event.response as Record<string, unknown> | undefined)?.error
      throw providerError(failure, response, event)
    }
    yield event
  }
}

export async function* readEvents(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let data: string[] = []
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      signal?.throwIfAborted()
      const next = await reader.read()
      buffer += decoder.decode(next.value, { stream: !next.done })
      if (buffer.length + data.reduce((size, line) => size + line.length, 0) > 8 * 1024 * 1024) {
        throw new LlmError('ChatGPT SSE 事件超过大小限制。', 'SIWC_INVALID_STREAM')
      }
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
        if (line !== '' || data.length === 0) continue
        const payload = data.join('\n')
        data = []
        if (payload === '[DONE]') continue
        let event: unknown
        try { event = JSON.parse(payload) } catch {
          throw new LlmError('ChatGPT SSE 事件格式错误。', 'SIWC_INVALID_STREAM')
        }
        if (!event || typeof event !== 'object') throw new LlmError('ChatGPT SSE 事件格式错误。', 'SIWC_INVALID_STREAM')
        yield event as Record<string, unknown>
      }
      if (next.done) return
    }
  } finally {
    signal?.removeEventListener('abort', cancel)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
