import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RequestDiagnostics } from '../src/diagnostics/requests.js'
import type { RequestDiagnostic } from '../src/diagnostics/types.js'

const secret = {keyId: 'fixture-key', secret: Buffer.alloc(32, 7)}
const connection = {id: 'fixture-connection', accountId: 'fixture-account', accessToken: 'fixture-token'}
const options = {provider: 'chatgpt-siwc', model: 'fixture-model', sessionId: SessionId('fixture-session'), messages: []}
const user = (text: string) => ({role: 'user', content: text})
const output = (text: string) => ({type: 'message', role: 'assistant', content: text})

for (const flushBeforeCompletion of [true, false]) {
  test(`newer request remains the baseline when an older request finishes later (${flushBeforeCompletion ? 'persisted' : 'pending'} writes)`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-baseline-concurrency-'))
    const records: RequestDiagnostic[] = []
    const store = {record: (record: RequestDiagnostic) => { records.push(record) }}
    const previousNow = Date.now
    let now = previousNow()
    Date.now = () => now
    const a = new RequestDiagnostics(store, () => 'conversation', {profileDir: dir, secret})
    const b = new RequestDiagnostics(store, () => 'conversation', {profileDir: dir, secret})
    try {
      const older = a.begin(connection, options)
      older.body({tools: [], input: [user('older')]})
      older.timing('request-sent')
      if (flushBeforeCompletion) await a.flushBaselines()

      now += 1000
      const newer = b.begin(connection, options)
      newer.body({tools: [], input: [user('newer')]})
      newer.timing('request-sent')
      newer.event({type: 'response.completed', response: {id: 'response-newer', output: [output('newer reply')]}})
      newer.finish('completed')
      const newerId = records.at(-1)!.id
      if (flushBeforeCompletion) await b.flushBaselines()

      now += 1000
      older.event({type: 'response.completed', response: {id: 'response-older', output: [output('older reply')]}})
      older.finish('completed')
      if (flushBeforeCompletion) await a.flushBaselines()

      now += 1000
      const c = new RequestDiagnostics(store, () => 'conversation', {profileDir: dir, secret})
      const next = c.begin(connection, options)
      next.body({tools: [], input: [user('newer'), output('newer reply')]})
      next.finish('cancelled')
      assert.equal(records.at(-1)?.baselineRequestId, newerId)
      assert.equal(records.at(-1)?.prefix?.expectedOutputMatched, true)
      await Promise.all([a.flushBaselines(), b.flushBaselines(), c.flushBaselines()])

      const restarted = new RequestDiagnostics(store, () => 'conversation', {profileDir: dir, secret})
      const afterRestart = restarted.begin(connection, options)
      afterRestart.body({tools: [], input: [user('newer'), output('newer reply')]})
      afterRestart.finish('cancelled')
      assert.equal(records.at(-1)?.baselineRequestId, newerId)
      assert.equal(records.at(-1)?.prefix?.expectedOutputMatched, true)
      await restarted.flushBaselines()
    } finally {
      Date.now = previousNow
      await Promise.all([a.flushBaselines(), b.flushBaselines()])
      await rm(dir, {recursive: true, force: true})
    }
  })
}
