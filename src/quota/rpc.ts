import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { access, chmod, mkdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, join } from 'node:path'

export interface CodexRpcOptions {
  binary?: string
  args?: readonly string[]
  timeoutMs?: number
}
export class CodexRpcError extends Error {
  constructor(readonly code: 'unavailable' | 'timeout' | 'closed' | 'protocol' | 'remote_error', readonly rpcCode?: number) {
    super({unavailable: '未找到可用的 Codex 程序。', timeout: 'Codex 额度查询超时。', closed: 'Codex 额度连接已关闭。',
      protocol: 'Codex 额度接口返回了无效数据。', remote_error: 'Codex 拒绝了额度查询操作。'}[code])
    this.name = 'CodexRpcError'
  }
}
type Pending = {resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>}
type Notification = (method: string, params: unknown) => void
const methods = new Set(['initialize', 'account/read', 'account/login/start', 'account/login/cancel',
  'account/logout', 'account/rateLimits/read'])
const maximumBuffer = 8 * 1024 * 1024

async function executable(binary?: string): Promise<string> {
  if (binary) return binary
  if (process.env.DSH_CHATGPT_CODEX_BINARY) return process.env.DSH_CHATGPT_CODEX_BINARY
  const candidates = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
    .filter(Boolean).flatMap(directory => process.platform === 'win32'
      ? ['codex.exe', 'codex.cmd'].map(name => join(directory, name)) : [join(directory, 'codex')])
  if (process.platform === 'darwin') candidates.push('/Applications/Codex.app/Contents/Resources/codex',
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex')
  for (const candidate of candidates) {
    // Windows command wrappers require a shell; only executable binaries are used.
    if (candidate.endsWith('.cmd')) continue
    try { await access(candidate, constants.X_OK); return candidate } catch { /* Try the next installed location. */ }
  }
  throw new CodexRpcError('unavailable')
}
function childEnvironment(home: string): NodeJS.ProcessEnv {
  const allowed = /^(PATH|PATHEXT|HOME|USERPROFILE|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|LANG|LC_.*|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS)$/i
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key)))
  return {...env, CODEX_HOME: home}
}

/** Owns one isolated Codex process and exposes only account/limit operations. */
export class CodexRpc {
  private sequence = 0
  private buffer = ''
  private stopped = false
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Set<Notification>()
  private readonly closeListeners = new Set<() => void>()
  private readonly exited: Promise<void>
  private closing?: Promise<void>

  private constructor(private readonly process: ChildProcessWithoutNullStreams, private readonly timeoutMs: number) {
    this.exited = new Promise(resolve => {
      process.once('close', () => { this.fail(new CodexRpcError('closed')); resolve() })
    })
    process.once('error', () => { this.fail(new CodexRpcError('unavailable')) })
    process.stdin.on('error', () => { this.fail(new CodexRpcError('closed')); void this.close() })
    process.stdout.on('error', () => { this.fail(new CodexRpcError('closed')); void this.close() })
    process.stdout.setEncoding('utf8')
    process.stdout.on('data', (value: string) => { this.receive(value) })
    process.stderr.resume()
  }
  static async start(home: string, options: CodexRpcOptions = {}): Promise<CodexRpc> {
    if (!isAbsolute(home)) throw new CodexRpcError('protocol')
    await mkdir(home, {recursive: true, mode: 0o700})
    await chmod(home, 0o700)
    const binary = await executable(options.binary)
    const args = options.args ?? ['app-server', '--listen', 'stdio://', '-c', 'cli_auth_credentials_store="file"']
    const child = spawn(binary, [...args], {cwd: home, env: childEnvironment(home), shell: false,
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']})
    const rpc = new CodexRpc(child, options.timeoutMs ?? 30_000)
    try {
      await rpc.request('initialize', {clientInfo: {name: 'dsh-chatgpt-siwc-quota', title: 'DSH ChatGPT usage', version: '1'},
        capabilities: {experimentalApi: true}})
      rpc.write({method: 'initialized'})
      return rpc
    } catch (error) { await rpc.close(); throw error }
  }
  request(method: string, params?: unknown): Promise<unknown> {
    if (!methods.has(method)) return Promise.reject(new CodexRpcError('protocol'))
    if (this.stopped) return Promise.reject(new CodexRpcError('closed'))
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new CodexRpcError('timeout'))
        void this.close()
      }, this.timeoutMs)
      this.pending.set(id, {resolve, reject, timer})
      try { this.write({id, method, ...(params === undefined ? {} : {params})}) }
      catch { this.fail(new CodexRpcError('protocol')); void this.close() }
    })
  }
  onNotification(listener: Notification): () => void {
    if (!this.stopped) this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  /** Closed instances notify newly registered listeners in the next microtask. */
  onClose(listener: () => void): () => void {
    if (this.stopped) {
      let subscribed = true
      queueMicrotask(() => { if (subscribed) listener() })
      return () => { subscribed = false }
    }
    this.closeListeners.add(listener)
    return () => { this.closeListeners.delete(listener) }
  }
  close(): Promise<void> {
    this.closing ??= this.stop()
    return this.closing
  }
  private async stop(): Promise<void> {
    this.fail(new CodexRpcError('closed'))
    if (this.process.exitCode === null && this.process.signalCode === null) this.process.kill()
    const force = setTimeout(() => { this.process.kill('SIGKILL') }, 1_000)
    try { await this.exited } finally { clearTimeout(force) }
  }
  private write(value: unknown): void {
    if (this.stopped) throw new CodexRpcError('closed')
    this.process.stdin.write(`${JSON.stringify(value)}\n`)
  }
  private receive(value: string): void {
    if (this.stopped) return
    this.buffer += value
    if (Buffer.byteLength(this.buffer) > maximumBuffer) {
      this.fail(new CodexRpcError('protocol')); void this.close(); return
    }
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (!line.trim()) continue
      try { this.dispatch(JSON.parse(line)) }
      catch { this.fail(new CodexRpcError('protocol')); void this.close(); return }
    }
  }
  private dispatch(value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CodexRpcError('protocol')
    const message = value as Record<string, unknown>
    if (typeof message.method === 'string') {
      if (message.id !== undefined) {
        this.write({id: message.id, error: {code: -32601, message: 'Method not found'}})
      } else for (const listener of this.listeners) listener(message.method, message.params)
      return
    }
    if (typeof message.id !== 'number') throw new CodexRpcError('protocol')
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.error !== undefined) {
      const code = (message.error as {code?: unknown} | null)?.code
      pending.reject(new CodexRpcError('remote_error', typeof code === 'number' ? code : undefined))
    } else if ('result' in message) pending.resolve(message.result)
    else pending.reject(new CodexRpcError('protocol'))
  }
  private fail(error: CodexRpcError): void {
    if (this.stopped) return
    this.stopped = true
    this.buffer = ''
    this.listeners.clear()
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
    const listeners = [...this.closeListeners]
    this.closeListeners.clear()
    for (const listener of listeners) listener()
  }
}
