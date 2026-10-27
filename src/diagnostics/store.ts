import { mkdir, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'
import { filterDiagnosticsRecords, summarizeDiagnosticsRecords } from './export.js'
import { diagnosticRecordSchema } from './schema.js'
import type { DiagnosticsFilter, DiagnosticsSnapshot, RequestDiagnostic } from './types.js'

const limit = 2000
const maxBytes = 8 * 1024 * 1024
const fileSchema = z.object({version: z.literal(1), records: z.array(diagnosticRecordSchema).max(limit)})
const readError = '诊断记录读取失败，已保留原文件；新记录仅在本次运行中可用。'
const writeError = '诊断记录保存失败，新记录仅在本次运行中可用。'

function mergeRecords(before: RequestDiagnostic[], added: RequestDiagnostic[]): RequestDiagnostic[] {
  const records = new Map(before.map(record => [record.id, record]))
  for (const record of added) records.set(record.id, record)
  return [...records.values()].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id)).slice(-limit)
}
async function readRecords(filename: string): Promise<RequestDiagnostic[]> {
  let file
  try { file = await open(filename, 'r') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
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
    return fileSchema.parse(JSON.parse(buffer.subarray(0, bytes).toString('utf8'))).records
  } finally { await file.close() }
}
function summarize(records: RequestDiagnostic[], storageError?: string, includeRecords = false): DiagnosticsSnapshot {
  const {groups, reasons, metrics} = summarizeDiagnosticsRecords(records)
  return {
    retained: records.length,
    limit,
    ...(records.length ? {since: Math.min(...records.map(record => record.startedAt))} : {}),
    ...(storageError ? {storageError} : {}),
    groups,
    reasons,
    metrics,
    models: [...new Set(records.map(record => record.model))].sort(),
    recent: records.slice(-30).reverse(),
    ...(includeRecords ? {records: [...records].reverse()} : {}),
  }
}

/** Each append re-reads under the Host writer lock, including across processes sharing a profile. */
export class DiagnosticsStore {
  private readonly filename: string
  private records: RequestDiagnostic[] = []
  private pending: RequestDiagnostic[] = []
  private queue: Promise<void> = Promise.resolve()
  private storageError?: string
  private blocked = false
  private disposed = false
  constructor(readonly profileDir: string) { this.filename = join(profileDir, 'chatgpt-siwc-diagnostics.json') }

  record(value: RequestDiagnostic): void {
    if (this.disposed) return
    const parsed = diagnosticRecordSchema.safeParse(value)
    if (!parsed.success) { this.storageError = '诊断记录格式无效，已跳过该条记录。'; return }
    this.pending.push(parsed.data)
    this.queue = this.queue.then(() => this.flush()).catch(() => { this.storageError = writeError })
  }
  private async flush(): Promise<void> {
    if (!this.pending.length) return
    const added = this.pending.splice(0)
    this.records = mergeRecords(this.records, added)
    if (this.blocked) return
    try {
      await mkdir(dirname(this.filename), {recursive: true, mode: 0o700})
      await withFileLock(this.filename, async () => {
        let previous: RequestDiagnostic[]
        try { previous = await readRecords(this.filename) }
        catch { this.blocked = true; this.storageError = readError; return }
        const records = mergeRecords(previous, this.records)
        await writeFileAtomic(this.filename, JSON.stringify({version: 1, records}), {mode: 0o600, dirMode: 0o700})
        this.records = records
        this.storageError = undefined
      })
    } catch { this.storageError = writeError }
  }
  async snapshot(filter?: DiagnosticsFilter, includeRecords = false): Promise<DiagnosticsSnapshot> {
    await this.queue
    if (!this.blocked) {
      try { this.records = mergeRecords(await readRecords(this.filename), this.records) }
      catch { this.blocked = true; this.storageError = readError }
    }
    const filtered = filterDiagnosticsRecords(this.records, filter)
    return summarize(filtered, this.storageError, includeRecords)
  }
  async query(filter?: DiagnosticsFilter): Promise<DiagnosticsSnapshot> {
    return this.snapshot(filter, true)
  }
  async dispose(): Promise<void> { this.disposed = true; await this.queue }
}
