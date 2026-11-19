import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { Context, Service } from '@deepseek-ai/cordis'
import Registry from '@deepseek-ai/dsh-typert-registry'
import * as Gateway from '@deepseek-ai/dsh-api-gateway/client'
import { z } from 'zod'
import type { SiwcStatus } from '../src/api/types.js'

const require = createRequire(import.meta.url)
const status: SiwcStatus = {authenticated: false, signingIn: false, planEnabled: false, availability: 'ready',
  accounts: [], models: [], authorizedSessions: [], allowBackground: false,
  usage: {requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0}}
type Registration = {name: string; key?: string; id?: string; inject?: (sessionId: string) => unknown}

test('built client mounts the real remote namespace before registering its login settings and cleans up', async () => {
  execFileSync(process.execPath, ['scripts/build-client.mjs'], {cwd: new URL('../', import.meta.url)})
  let factory!: (require: (name: string) => unknown) => {apply(ctx: Context): Promise<void>; inject: string[]}
  vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window: {__ModuleLoader__: {load(value: {factory: typeof factory}) { factory = value.factory }}},
    setTimeout, clearTimeout,
  })
  const plugin = factory(name => name === '@deepseek-ai/dsh-client-ui-primitives'
    ? {Button() {}, Switch() {}, Tag() {}} : require(name))
  const entries = new Map<string, {options: Registration; component: () => {props: {controller: {
    getSnapshot(): {status?: SiwcStatus}; run(action: string): Promise<void>
  }}}}>()
  class Slots extends Service {
    constructor(ctx: Context) { super(ctx, 'slots') }
    inject(_name: string, callback: () => () => void) { return this.ctx.effect(callback) }
    register(options: Registration, component: () => never) {
      return this.ctx.effect(() => {
        entries.set(options.name, {options, component})
        return () => { entries.delete(options.name) }
      })
    }
  }
  const ctx = new Context()
  const calls: string[] = []
  ctx.provide('connection', {
    interactions: 'none', isLoopback: true, generation: {getSnapshot: () => undefined},
    rpc: {open() { throw new Error('No fixture streams') }, async call(_base: string, endpoint: string) {
      calls.push(endpoint)
      return {ok: true, value: status}
    }},
  } as never)
  const store = {getSnapshot: () => ({current: undefined}), subscribe: () => () => {}}
  class ModelDirectories extends Service {
    static inject = ['remote', 'remote.session']
    constructor(ctx: Context) { super(ctx, 'modelDirectories') }
    directoryFor(_sessionId: string) {
      // Mirrors dsh-client-ui-model-selection's ModelDirectoryResolver.directoryFor, which reads
      // this.ctx.remote.session through Cordis's traceable service proxy.
      assert.ok((this.ctx as unknown as {remote: {session: unknown}}).remote.session)
      return {store}
    }
  }
  try {
    await ctx.plugin(Registry)
    await ctx.plugin(Gateway)
    await (ctx.remote as unknown as {$mount(contribution: unknown): Promise<void>}).$mount({
      package: 'fixture-session-remote',
      descriptors: [{
        id: 'fixture-session-remote#session/ping', service: 'session', namespace: 'session', method: 'ping',
        invocation: {kind: 'direct'}, parameters: [], result: {mode: 'strict', typeSymbol: 'boolean', create: () => z.boolean()},
      }],
    })
    await ctx.plugin(ModelDirectories)
    await ctx.plugin(Slots)
    const mounted = ctx.plugin(plugin)
    await mounted
    const settings = entries.get('plugins.bundle.config')
    assert.equal(settings?.options.key, 'dsh-plugin-chatgpt-siwc')
    assert.deepEqual([...entries.keys()], ['plugins.bundle.config', 'conversation.input.right'])
    const quotaSlot = entries.get('conversation.input.right')
    assert.equal(quotaSlot?.options.id, 'chatgpt-siwc-quota')
    assert.equal((quotaSlot?.options.inject?.('fixture-session') as {directory?: unknown})?.directory, store)
    const controller = settings!.component().props.controller
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(controller.getSnapshot().status?.authenticated, false)
    assert.ok(calls.includes('chatgptSiwc/status'))
    await controller.run('beginSignIn')
    assert.ok(calls.includes('chatgptSiwc/beginSignIn'))
    await mounted.dispose()
    assert.equal(entries.size, 0)
    assert.equal(ctx.get('remote.chatgptSiwc'), undefined)
  } finally { await ctx.fiber.dispose() }
})
