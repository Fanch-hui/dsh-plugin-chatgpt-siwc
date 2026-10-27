import WebSocket from 'ws'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { classifyWireEvent } from '../events.js'
import type { DisconnectCause, DisconnectDiagnostic, WireEvent } from './types.js'

function validCloseCode(code: unknown): code is number {
  return typeof code === 'number' && Number.isInteger(code) && code >= 1000 && code <= 4999
}
function validEventType(type: unknown): type is string {
  return typeof type === 'string' && /^[a-zA-Z0-9._:-]{1,96}$/.test(type)
}
function validSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export class SocketInterrupted extends LlmError {
  constructor(readonly disconnect?: DisconnectDiagnostic) {
    super('ChatGPT WebSocket 连接中断。', 'SIWC_SOCKET_INTERRUPTED')
  }
}
const protectedSockets = new WeakSet<WebSocket>()
export function protectSocket(socket: WebSocket): WebSocket {
  if (!protectedSockets.has(socket)) {
    protectedSockets.add(socket)
    socket.on('error', () => socket.terminate())
  }
  return socket
}

export async function probeSocket(socket: WebSocket, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted || socket.readyState !== WebSocket.OPEN) return false
  if (typeof socket.ping !== 'function') return true
  return new Promise<boolean>(resolve => {
    let settled = false
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onFail)
      socket.off('pong', onPong)
      socket.off('close', onFail)
      socket.off('error', onFail)
    }
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(ok)
    }
    const onPong = () => done(true)
    const onFail = () => done(false)
    const timer = setTimeout(onFail, timeoutMs)
    socket.once('pong', onPong)
    socket.once('close', onFail)
    socket.once('error', onFail)
    signal?.addEventListener('abort', onFail, {once: true})
    if (signal?.aborted) {
      onFail()
      return
    }
    try {
      socket.ping()
    } catch {
      onFail()
    }
  })
}

export function startHeartbeat(
  socket: WebSocket,
  intervalMs: number,
  pongTimeoutMs: number,
  onUnhealthy: () => void,
): () => void {
  if (typeof socket.ping !== 'function' || intervalMs <= 0) return () => {}
  let intervalTimer: ReturnType<typeof setTimeout> | undefined
  let pongTimer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const clearTimers = () => {
    if (intervalTimer !== undefined) { clearTimeout(intervalTimer); intervalTimer = undefined }
    if (pongTimer !== undefined) { clearTimeout(pongTimer); pongTimer = undefined }
  }
  const cleanup = () => {
    if (stopped) return
    stopped = true
    clearTimers()
    socket.off('pong', onPong)
    socket.off('close', cleanup)
  }
  const onPong = () => {
    if (pongTimer !== undefined) {
      clearTimeout(pongTimer)
      pongTimer = undefined
    }
  }
  const scheduleNext = () => {
    if (stopped) return
    const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(intervalMs * 0.1)))
    intervalTimer = setTimeout(sendPing, intervalMs + jitter)
    intervalTimer.unref()
  }
  const sendPing = () => {
    if (stopped || socket.readyState !== WebSocket.OPEN) {
      cleanup()
      return
    }
    if (pongTimer === undefined) {
      pongTimer = setTimeout(() => {
        pongTimer = undefined
        if (stopped) return
        cleanup()
        onUnhealthy()
      }, pongTimeoutMs)
      pongTimer.unref()
      try {
        socket.ping()
      } catch {
        cleanup()
        onUnhealthy()
        return
      }
    }
    scheduleNext()
  }
  socket.on('pong', onPong)
  socket.once('close', cleanup)
  scheduleNext()
  return cleanup
}
export async function connectSocket(headers: Record<string, string>, signal?: AbortSignal): Promise<WebSocket> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const socket = new WebSocket('wss://api.openai.com/v1/responses', {
      headers, handshakeTimeout: 15_000, maxPayload: 8 * 1024 * 1024, followRedirects: false,
    })
    let cause: DisconnectCause | undefined
    const cleanup = () => {
      signal?.removeEventListener('abort', cancel)
      socket.off('open', open)
      socket.off('error', onError)
      socket.off('close', onClose)
    }
    const fail = (fallback: DisconnectCause, closeCode?: number) => {
      cleanup()
      socket.on('error', () => {})
      socket.terminate()
      reject(new SocketInterrupted({ cause: cause ?? fallback, ...(validCloseCode(closeCode) ? { closeCode } : {}) }))
    }
    const onError = (error: Error) => {
      cause ??= /timed?\s*out/i.test(error.message) ? 'timeout' : 'handshake-failed'
      fail(cause)
    }
    const onClose = (code: number) => { fail('handshake-failed', code) }
    const cancel = () => { fail('handshake-failed') }
    const open = () => { cleanup(); resolve(protectSocket(socket)) }
    socket.once('open', open)
    socket.once('error', onError)
    socket.once('close', onClose)
    signal?.addEventListener('abort', cancel, {once: true})
    if (signal?.aborted) cancel()
  })
}

/** Listeners are installed before send so the first event cannot be lost. */
export async function* socketEvents(socket: WebSocket, body: Record<string, unknown>, signal: AbortSignal | undefined,
  timeoutMs: number): AsyncGenerator<WireEvent> {
  const events: WireEvent[] = []
  let failure: unknown
  let fatal = false
  let wake: (() => void) | undefined
  let queuedBytes = 0
  let eventCount = 0
  let lastEventType: string | undefined
  let lastEventSequence: number | undefined
  let closeCode: number | undefined
  let disconnectCause: DisconnectCause | undefined
  let timer: ReturnType<typeof setTimeout>
  const notify = () => { wake?.(); wake = undefined }
  const buildInterrupt = (fallback: DisconnectCause = 'remote-closed') => new SocketInterrupted({
    cause: disconnectCause ?? fallback,
    ...(closeCode === undefined ? {} : { closeCode }),
    ...(lastEventType === undefined ? {} : { lastEventType }),
    ...(lastEventSequence === undefined ? {} : { lastEventSequence }),
  })
  const stop = (error: unknown, protocol = false) => {
    if (protocol) { fatal = true; failure = error; events.length = 0; queuedBytes = 0 }
    else failure ??= error
    notify()
  }
  const fail = (cause: DisconnectCause = 'remote-closed') => {
    disconnectCause ??= cause
    stop(buildInterrupt(cause))
  }
  const socketError = (error: Error & {code?: string}) => {
    if (error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') {
      stop(new LlmError('ChatGPT WebSocket 事件超过大小限制。', 'SIWC_INVALID_STREAM'), true)
    } else fail('socket-error')
  }
  const socketClose = (code: number) => {
    if (validCloseCode(code)) closeCode = code
    fail('remote-closed')
  }
  const cancel = () => stop(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => fail('timeout'), timeoutMs); timer.unref() }
  const message = (raw: WebSocket.RawData) => {
    if (fatal) return
    arm()
    const text = raw.toString()
    queuedBytes += Buffer.byteLength(text)
    if (queuedBytes > 16 * 1024 * 1024) { stop(new LlmError('ChatGPT WebSocket 事件超过大小限制。', 'SIWC_INVALID_STREAM'), true); return }
    try {
      const event: unknown = JSON.parse(text)
      if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error()
      events.push(event as WireEvent)
      notify()
    } catch { stop(new LlmError('ChatGPT WebSocket 事件格式错误。', 'SIWC_INVALID_STREAM'), true) }
  }
  socket.on('message', message)
  socket.on('error', socketError)
  socket.on('close', socketClose)
  signal?.addEventListener('abort', cancel, {once: true})
  arm()
  try {
    signal?.throwIfAborted()
    if (socket.readyState !== WebSocket.OPEN) throw buildInterrupt('remote-closed')
    socket.send(JSON.stringify({...body, type: 'response.create'}), error => { if (error) fail('send-failed') })
    while (true) {
      signal?.throwIfAborted()
      if (fatal) throw failure
      const event = events.shift()
      if (!event) {
        if (failure) throw failure instanceof SocketInterrupted ? buildInterrupt(failure.disconnect?.cause) : failure
        await new Promise<void>(resolve => { wake = resolve })
        continue
      }
      eventCount++
      if (validEventType(event.type)) lastEventType = event.type
      lastEventSequence = validSequence(event.sequence_number) ? event.sequence_number : eventCount
      queuedBytes = Math.max(0, queuedBytes - Buffer.byteLength(JSON.stringify(event)))
      yield event
      if (classifyWireEvent(event).terminal) return
    }
  } finally {
    clearTimeout(timer!)
    signal?.removeEventListener('abort', cancel)
    socket.off('message', message)
    socket.off('error', socketError)
    socket.off('close', socketClose)
  }
}
