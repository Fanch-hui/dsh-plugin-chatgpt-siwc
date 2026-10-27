import { readFileSync, statSync } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'
import type { SystemPromptSource } from './types.js'

export const baselineRetentionMs = 24 * 60 * 60_000
export const maxRouteBaselines = 128
export const maxPrefixBaselines = 128
export const maxBaselineItems = 4096
export const maxBaselineBytes = 2 * 1024 * 1024

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const boundedId = z.string().min(1).max(64)

export interface RouteBaseline {
  lane: string; startedAt: number; updatedAt: number; account: string; connection: string
  model: string; wire: string; runtimeId?: string; attemptId?: string; baselineRequestId?: string
}

export interface PrefixBaseline {
  lane: string; scope: string; keyId: string; startedAt: number; updatedAt: number; baselineRequestId: string
  runtimeId?: string; attemptId?: string; instructions: string; tools: string; settings: string; policy?: string
  developerHashes?: string[]; systemPromptSource?: SystemPromptSource; items: string[]; expectedNextInputHashes?: string[]
}

const routeSchema: z.ZodType<RouteBaseline> = z.object({
  lane: hash, startedAt: count, updatedAt: count, account: hash, connection: hash,
  model: z.string().min(1).max(512), wire: hash, runtimeId: z.string().uuid().optional(),
  attemptId: boundedId.optional(), baselineRequestId: boundedId.optional(),
})

const prefixSchema: z.ZodType<PrefixBaseline> = z.object({
  lane: hash, scope: hash, keyId: boundedId, startedAt: count, updatedAt: count,
  baselineRequestId: boundedId, runtimeId: z.string().uuid().optional(), attemptId: boundedId.optional(),
  instructions: hash, tools: hash, settings: hash, policy: hash.optional(),
  developerHashes: z.array(hash).max(64).optional(),
  systemPromptSource: z.enum(['system-field', 'leading-message', 'in-history', 'none']).optional(),
  items: z.array(hash).max(maxBaselineItems),
  expectedNextInputHashes: z.array(hash).max(maxBaselineItems).optional(),
})

interface PersistedBaselines {
  version: 1
  keyId?: string
  routes: RouteBaseline[]
  prefixes: PrefixBaseline[]
}

const fileSchema: z.ZodType<PersistedBaselines> = z.object({
  version: z.literal(1), keyId: boundedId.optional(),
  routes: z.array(routeSchema).max(maxRouteBaselines),
  prefixes: z.array(prefixSchema).max(maxPrefixBaselines),
})

const inFlightByFile = new Map<string, Map<BaselineStore, PersistedBaselines>>()

function isNewerPrefix(candidate: PrefixBaseline, previous: PrefixBaseline): boolean {
  if (candidate.startedAt !== previous.startedAt) return candidate.startedAt > previous.startedAt
  return candidate.updatedAt >= previous.updatedAt
}

function readSyncFile(filename: string): PersistedBaselines | undefined {
  try {
    if (statSync(filename).size > maxBaselineBytes) return undefined
    return fileSchema.parse(JSON.parse(readFileSync(filename, 'utf8')))
  } catch { return undefined }
}

async function readAsyncFile(filename: string): Promise<PersistedBaselines | undefined> {
  let file
  try { file = await open(filename, 'r') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {version: 1, routes: [], prefixes: []}
    return undefined
  }
  try {
    if ((await file.stat()).size > maxBaselineBytes) return undefined
    const buffer = Buffer.alloc(maxBaselineBytes + 1)
    let bytes = 0
    while (bytes < buffer.length) {
      const chunk = await file.read(buffer, bytes, buffer.length - bytes, null)
      if (!chunk.bytesRead) break
      bytes += chunk.bytesRead
    }
    if (bytes > maxBaselineBytes) return undefined
    return fileSchema.parse(JSON.parse(buffer.subarray(0, bytes).toString('utf8')))
  } catch { return undefined }
  finally { await file.close() }
}

function serializeBounded(
  routes: Map<string, RouteBaseline>,
  prefixes: Map<string, PrefixBaseline>,
  keyId: string | undefined,
  now: number,
): string {
  for (const [lane, entry] of routes) if (now - entry.updatedAt > baselineRetentionMs) routes.delete(lane)
  for (const [lane, entry] of prefixes) {
    if (now - entry.updatedAt > baselineRetentionMs || (keyId && entry.keyId !== keyId)) prefixes.delete(lane)
  }
  while (routes.size > maxRouteBaselines) routes.delete(routes.keys().next().value!)
  while (prefixes.size > maxPrefixBaselines) prefixes.delete(prefixes.keys().next().value!)

  const buildJson = () => JSON.stringify({
    version: 1, ...(keyId ? {keyId} : {}),
    routes: [...routes.values()], prefixes: [...prefixes.values()],
  })
  let json = buildJson()
  while (Buffer.byteLength(json, 'utf8') > maxBaselineBytes && (routes.size > 0 || prefixes.size > 0)) {
    const oldestRoute = routes.values().next().value as RouteBaseline | undefined
    const oldestPrefix = prefixes.values().next().value as PrefixBaseline | undefined
    if (oldestPrefix && (!oldestRoute || oldestPrefix.updatedAt <= oldestRoute.updatedAt)) prefixes.delete(oldestPrefix.lane)
    else if (oldestRoute) routes.delete(oldestRoute.lane)
    json = buildJson()
  }
  return json
}

export class BaselineStore {
  private readonly filename?: string
  private readonly routes = new Map<string, RouteBaseline>()
  private readonly prefixes = new Map<string, PrefixBaseline>()
  private readonly deletedPrefixLanes = new Set<string>()
  private clearedAll = false
  private keyId?: string
  private queue: Promise<void> = Promise.resolve()

  constructor(profileDir?: string, keyId?: string) {
    this.keyId = keyId
    if (!profileDir) return
    this.filename = join(profileDir, 'chatgpt-siwc-baselines.json')
    this.loadSources(Date.now())
  }

  private loadSources(now: number): void {
    if (!this.filename || this.clearedAll) return
    for (const source of [readSyncFile(this.filename), ...(inFlightByFile.get(this.filename)?.values() ?? [])]) {
      if (!source) continue
      for (const route of source.routes) {
        const prev = this.routes.get(route.lane)
        if (now - route.updatedAt <= baselineRetentionMs && (!prev || route.startedAt >= prev.startedAt)) {
          this.routes.delete(route.lane)
          this.routes.set(route.lane, route)
        }
      }
      for (const prefix of source.prefixes) {
        const prev = this.prefixes.get(prefix.lane)
        if (now - prefix.updatedAt <= baselineRetentionMs && (!this.keyId || prefix.keyId === this.keyId)
          && (!prev || prev.keyId !== prefix.keyId || isNewerPrefix(prefix, prev))) {
          this.prefixes.delete(prefix.lane)
          this.prefixes.set(prefix.lane, prefix)
          this.deletedPrefixLanes.delete(prefix.lane)
        }
      }
    }
    serializeBounded(this.routes, this.prefixes, this.keyId, now)
  }

  rotateKey(keyId: string): void {
    if (this.keyId === keyId) return
    this.keyId = keyId
    const now = Date.now()
    for (const [lane, entry] of this.prefixes) {
      if (entry.keyId !== keyId) {
        this.prefixes.delete(lane)
        this.deletedPrefixLanes.add(lane)
      }
    }
    this.loadSources(now)
    this.scheduleWrite(now)
  }

  getRoute(lane: string, now = Date.now()): RouteBaseline | undefined {
    const entry = this.routes.get(lane)
    if (!entry) return undefined
    if (now - entry.updatedAt > baselineRetentionMs) {
      this.routes.delete(lane)
      return undefined
    }
    return entry
  }

  setRoute(entry: RouteBaseline, now = Date.now()): void {
    this.routes.delete(entry.lane)
    this.routes.set(entry.lane, entry)
    serializeBounded(this.routes, this.prefixes, this.keyId, now)
    this.scheduleWrite(now)
  }

  getPrefix(lane: string, keyId: string, now = Date.now()): PrefixBaseline | undefined {
    const entry = this.prefixes.get(lane)
    if (!entry || entry.keyId !== keyId || (this.keyId !== undefined && keyId !== this.keyId)) return undefined
    if (now - entry.updatedAt > baselineRetentionMs) {
      this.prefixes.delete(lane)
      this.deletedPrefixLanes.add(lane)
      return undefined
    }
    return entry
  }

  setPrefix(entry: PrefixBaseline, now = Date.now()): void {
    if (this.keyId !== undefined && entry.keyId !== this.keyId) return
    if (entry.items.length > maxBaselineItems) {
      this.deletePrefix(entry.lane, now)
      return
    }
    this.deletedPrefixLanes.delete(entry.lane)
    this.prefixes.delete(entry.lane)
    this.prefixes.set(entry.lane, entry)
    serializeBounded(this.routes, this.prefixes, this.keyId, now)
    this.scheduleWrite(now)
  }

  deletePrefix(lane: string, now = Date.now()): void {
    if (this.prefixes.delete(lane)) {
      this.deletedPrefixLanes.add(lane)
      this.scheduleWrite(now)
    }
  }

  deletePrefixScope(scope: string, now = Date.now()): void {
    let changed = false
    for (const [lane, baseline] of this.prefixes) {
      if (baseline.scope === scope) {
        this.prefixes.delete(lane)
        this.deletedPrefixLanes.add(lane)
        changed = true
      }
    }
    if (changed) this.scheduleWrite(now)
  }

  async clear(): Promise<void> {
    this.routes.clear()
    this.prefixes.clear()
    this.deletedPrefixLanes.clear()
    this.clearedAll = true
    this.scheduleWrite()
    await this.queue
  }

  async flush(): Promise<void> {
    await this.queue
  }

  private scheduleWrite(now = Date.now()): void {
    if (!this.filename) return
    const filename = this.filename
    const json = serializeBounded(this.routes, this.prefixes, this.keyId, now)
    const snapshot = JSON.parse(json) as PersistedBaselines
    const inFlight = inFlightByFile.get(filename) ?? new Map<BaselineStore, PersistedBaselines>()
    inFlight.set(this, snapshot)
    inFlightByFile.set(filename, inFlight)
    const finishSnapshot = () => {
      if (inFlight.get(this) !== snapshot) return
      inFlight.delete(this)
      if (!inFlight.size) inFlightByFile.delete(filename)
    }
    this.queue = this.queue.then(async () => {
      try {
        await mkdir(dirname(filename), {recursive: true, mode: 0o700})
        await withFileLock(filename, async () => {
          const previous = this.clearedAll ? {version: 1 as const, routes: [], prefixes: []} : await readAsyncFile(filename)
          this.clearedAll = false
          const mergedRoutes = new Map<string, RouteBaseline>()
          const mergedPrefixes = new Map<string, PrefixBaseline>()
          if (previous) {
            for (const route of previous.routes) mergedRoutes.set(route.lane, route)
            for (const prefix of previous.prefixes) {
              if (!this.deletedPrefixLanes.has(prefix.lane) && (!this.keyId || prefix.keyId === this.keyId)) {
                mergedPrefixes.set(prefix.lane, prefix)
              }
            }
          }
          for (const [lane, route] of this.routes) {
            const prev = mergedRoutes.get(lane)
            if (!prev || route.startedAt >= prev.startedAt) {
              mergedRoutes.delete(lane)
              mergedRoutes.set(lane, route)
            }
          }
          for (const [lane, prefix] of this.prefixes) {
            const prev = mergedPrefixes.get(lane)
            if (!prev || isNewerPrefix(prefix, prev)) {
              mergedPrefixes.delete(lane)
              mergedPrefixes.set(lane, prefix)
            }
          }
          this.deletedPrefixLanes.clear()
          const payload = serializeBounded(mergedRoutes, mergedPrefixes, this.keyId, Date.now())
          await writeFileAtomic(filename, payload, {mode: 0o600, dirMode: 0o700})
          finishSnapshot()
        })
      } catch {
        finishSnapshot()
      }
    })
  }
}
