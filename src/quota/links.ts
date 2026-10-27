import { mkdir, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const limit = 128
const maxBytes = 64 * 1024
const fileSchema = z.object({version: z.literal(1), links: z.record(hash, hash)
  .refine(value => Object.keys(value).length <= limit)})
const readError = '额度关联记录读取失败，请检查本机存储后重试。'
const writeError = '额度关联记录保存失败，请重试。'
const formatError = '额度关联标识格式无效。'
const limitError = '额度关联数量已达上限。'

async function readLinks(filename: string): Promise<Map<string, string>> {
  let file
  try { file = await open(filename, 'r') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map()
    throw new Error(readError)
  }
  try {
    if ((await file.stat()).size > maxBytes) throw new Error(readError)
    const buffer = Buffer.alloc(maxBytes + 1)
    let bytes = 0
    while (bytes < buffer.length) {
      const chunk = await file.read(buffer, bytes, buffer.length - bytes, null)
      if (!chunk.bytesRead) break
      bytes += chunk.bytesRead
    }
    if (bytes > maxBytes) throw new Error(readError)
    const parsed = fileSchema.parse(JSON.parse(buffer.subarray(0, bytes).toString('utf8')))
    return new Map(Object.entries(parsed.links))
  } catch { throw new Error(readError) }
  finally { await file.close() }
}

/** User-confirmed associations contain only anonymous registration and quota-source identifiers. */
export class QuotaLinks {
  private readonly filename: string
  private persistent = new Map<string, string>()
  private readonly ephemeral = new Map<string, string>()
  private loading?: Promise<void>
  private queue: Promise<void> = Promise.resolve()

  constructor(profileDir: string) { this.filename = join(profileDir, 'chatgpt-siwc-quota-links.json') }

  load(): Promise<void> {
    return this.loading ??= readLinks(this.filename).then(links => { this.persistent = links })
  }

  matches(accountId: string, sourceKey: string): boolean {
    if (!hash.safeParse(accountId).success || !hash.safeParse(sourceKey).success) return false
    return (this.ephemeral.get(accountId) ?? this.persistent.get(accountId)) === sourceKey
  }

  bind(accountId: string, sourceKey: string, persistent: boolean): Promise<void> {
    if (!hash.safeParse(accountId).success || !hash.safeParse(sourceKey).success) return Promise.reject(new Error(formatError))
    return this.change(links => {
      if (persistent) links.set(accountId, sourceKey)
      else links.delete(accountId)
      if (new Set([...links.keys(), ...this.ephemeral.keys(), accountId]).size > limit) throw new Error(limitError)
    }, () => {
      if (persistent) this.ephemeral.delete(accountId)
      else this.ephemeral.set(accountId, sourceKey)
    })
  }

  unlink(accountId: string): Promise<void> {
    if (!hash.safeParse(accountId).success) return Promise.reject(new Error(formatError))
    return this.change(links => { links.delete(accountId) }, () => { this.ephemeral.delete(accountId) })
  }

  clear(): Promise<void> {
    return this.change(links => { links.clear() }, () => { this.ephemeral.clear() })
  }

  private change(mutate: (links: Map<string, string>) => void, committed: () => void): Promise<void> {
    const next = this.queue.then(async () => {
      await this.load()
      try {
        await mkdir(dirname(this.filename), {recursive: true, mode: 0o700})
        await withFileLock(this.filename, async () => {
          let links: Map<string, string>
          try { links = await readLinks(this.filename) }
          catch { this.persistent.clear(); throw new Error(readError) }
          mutate(links)
          if (links.size > limit) throw new Error(limitError)
          await writeFileAtomic(this.filename, JSON.stringify({version: 1, links: Object.fromEntries(links)}), {mode: 0o600, dirMode: 0o700})
          this.persistent = links
          committed()
        })
      } catch (error) {
        if (error instanceof Error && [readError, limitError].includes(error.message)) throw error
        throw new Error(writeError)
      }
    })
    this.queue = next.catch(() => {})
    return next
  }
}
