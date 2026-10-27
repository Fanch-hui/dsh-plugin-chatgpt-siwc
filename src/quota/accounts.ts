import { randomUUID } from 'node:crypto'
import { access, mkdir, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'

const slotId = z.union([z.literal('legacy'), z.uuid()])
const sourceHash = z.string().regex(/^[a-f0-9]{64}$/)
const slot = z.strictObject({id: slotId, sourceKey: sourceHash.optional()})
const registrySchema = z.discriminatedUnion('version', [
  z.strictObject({version: z.literal(1), accounts: z.array(slotId).max(128)}),
  z.strictObject({version: z.literal(2), accounts: z.array(slot).max(128)}),
])
const maxBytes = 32 * 1024
const storageError = '额度账号记录读取失败，请检查本机存储后重试。'
export interface QuotaAccountRecord { id: string; sourceKey?: string }

export function quotaHome(profileDir: string, id: string): string {
  if (!slotId.safeParse(id).success) throw new Error('额度账号标识无效。')
  return id === 'legacy' ? join(profileDir, 'chatgpt-siwc-codex-quota')
    : join(profileDir, 'chatgpt-siwc-codex-quota-accounts', id)
}

async function hasLegacyLogin(profileDir: string): Promise<boolean> {
  try { await access(join(quotaHome(profileDir, 'legacy'), 'auth.json')); return true }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw new Error(storageError, {cause: error})
  }
}

/** Stores local slot identifiers and stable anonymous quota-source hashes. */
export class QuotaAccounts {
  private readonly filename: string
  private queue: Promise<void> = Promise.resolve()
  constructor(private readonly profileDir: string) {
    this.filename = join(profileDir, 'chatgpt-siwc-quota-accounts.json')
  }

  async read(): Promise<QuotaAccountRecord[]> {
    let file
    try { file = await open(this.filename, 'r') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return await hasLegacyLogin(this.profileDir) ? [{id: 'legacy'}] : []
      }
      throw new Error(storageError, {cause: error})
    }
    try {
      if ((await file.stat()).size > maxBytes) throw new Error(storageError)
      const buffer = Buffer.alloc(maxBytes + 1)
      let bytes = 0
      while (bytes < buffer.length) {
        const chunk = await file.read(buffer, bytes, buffer.length - bytes, null)
        if (!chunk.bytesRead) break
        bytes += chunk.bytesRead
      }
      if (bytes > maxBytes) throw new Error(storageError)
      const data = registrySchema.parse(JSON.parse(buffer.subarray(0, bytes).toString('utf8')))
      const accounts = data.version === 1 ? data.accounts.map(id => ({id})) : data.accounts
      if (new Set(accounts.map(account => account.id)).size !== accounts.length) throw new Error(storageError)
      const sources = accounts.flatMap(account => 'sourceKey' in account && account.sourceKey ? [account.sourceKey] : [])
      if (new Set(sources).size !== sources.length) throw new Error(storageError)
      return accounts
    } catch (error) { throw new Error(storageError, {cause: error}) }
    finally { await file.close() }
  }

  add(id: string = randomUUID()): Promise<string> {
    if (!slotId.safeParse(id).success) return Promise.reject(new Error('额度账号标识无效。'))
    return this.change(accounts => {
      if (accounts.some(account => account.id === id)) return {value: id, changed: false}
      if (accounts.length >= 128) throw new Error('额度账号数量已达上限。')
      accounts.push({id})
      return {value: id, changed: true}
    })
  }

  setSource(id: string, sourceKey?: string): Promise<void> {
    if (!slotId.safeParse(id).success || (sourceKey !== undefined && !sourceHash.safeParse(sourceKey).success)) {
      return Promise.reject(new Error('额度账号标识无效。'))
    }
    return this.change(accounts => {
      const account = accounts.find(value => value.id === id)
      if (!account) throw new Error('额度账号不存在，请刷新后重试。')
      if (sourceKey && accounts.some(value => value.id !== id && value.sourceKey === sourceKey)) {
        throw new Error('该额度账号已连接，请选择已有连接。')
      }
      if (account.sourceKey === sourceKey) return {value: undefined, changed: false}
      if (sourceKey) account.sourceKey = sourceKey
      else delete account.sourceKey
      return {value: undefined, changed: true}
    })
  }

  clearSource(id: string, sourceKey: string): Promise<void> {
    if (!slotId.safeParse(id).success || !sourceHash.safeParse(sourceKey).success) {
      return Promise.reject(new Error('额度账号标识无效。'))
    }
    return this.change(accounts => {
      const account = accounts.find(value => value.id === id)
      if (!account || account.sourceKey !== sourceKey) return {value: undefined, changed: false}
      delete account.sourceKey
      return {value: undefined, changed: true}
    })
  }

  remove(id: string): Promise<void> {
    if (!slotId.safeParse(id).success) return Promise.reject(new Error('额度账号标识无效。'))
    return this.change(accounts => {
      const index = accounts.findIndex(account => account.id === id)
      if (index === -1) return {value: undefined, changed: false}
      accounts.splice(index, 1)
      return {value: undefined, changed: true}
    })
  }

  private change<T>(mutate: (accounts: QuotaAccountRecord[]) => {value: T; changed: boolean}): Promise<T> {
    const next = this.queue.then(async () => {
      await mkdir(dirname(this.filename), {recursive: true, mode: 0o700})
      return withFileLock(this.filename, async () => {
        const accounts = await this.read()
        const result = mutate(accounts)
        if (result.changed) {
          await writeFileAtomic(this.filename, JSON.stringify({version: 2, accounts}), {mode: 0o600, dirMode: 0o700})
        }
        return result.value
      })
    })
    this.queue = next.then(() => {}, () => {})
    return next
  }
}
