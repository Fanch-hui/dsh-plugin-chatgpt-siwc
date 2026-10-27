import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexRpc, CodexRpcError } from '../src/quota/rpc.js'

const fixture = `
const readline = require('node:readline');
const mode = process.argv[1];
if (mode === 'resist') process.on('SIGTERM', () => {});
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({input: process.stdin}).on('line', line => {
  const value = JSON.parse(line);
  if (value.method === 'initialize') {
    send({id: value.id, result: {experimental: value.params.capabilities.experimentalApi,
      client: value.params.clientInfo.name}});
    return;
  }
  if (value.method === 'initialized') return;
  if (value.method === 'account/login/start' && mode === 'loginExit') {
    send({id: value.id, result: {type: 'chatgpt', loginId: 'fixture-login'}});
    setTimeout(() => process.exit(0), 20);
    return;
  }
  if (value.method === 'account/read') {
    if (mode === 'exit') return process.exit(0);
    if (mode === 'hang') return;
    if (mode === 'resist') return send({id: value.id, result: {pid: process.pid}});
    if (mode === 'invalid') return process.stdout.write('synthetic-invalid-json\\n');
    if (mode === 'oversized') return process.stdout.write('x'.repeat(8 * 1024 * 1024 + 1));
    if (mode === 'error') {
      process.stderr.write('synthetic-private-diagnostic');
      return send({id: value.id, error: {code: -32001, message: 'synthetic-private-diagnostic'}});
    }
    send({id: value.id, result: {home: process.env.CODEX_HOME, cwd: process.cwd(),
      hasApiKey: !!process.env.OPENAI_API_KEY, hasToken: !!process.env.CODEX_ACCESS_TOKEN,
      account: null}});
    send({method: 'account/rateLimits/updated', params: {usedPercent: 42}});
    send({id: 991, method: 'account/chatgptAuthTokens/refresh', params: {synthetic: 'private'}});
    return;
  }
  if (value.id === 991) {
    send({method: 'fixture/rejectedRequest', params: value.error});
    return;
  }
  if (value.method === 'account/rateLimits/read') {
    setTimeout(() => send({id: value.id, result: {primary: {usedPercent: value.params.order}}}), value.params.delay);
  }
});
`
async function setup(mode = 'normal', timeoutMs = 1_000) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-quota-rpc-'))
  try {
    const rpc = await CodexRpc.start(home, {binary: process.execPath, args: ['-e', fixture, mode], timeoutMs})
    return {rpc, home, async close() { await rpc.close(); await rm(home, {recursive: true, force: true}) }}
  } catch (error) { await rm(home, {recursive: true, force: true}); throw error }
}

test('quota RPC isolates credentials, handles notifications and refuses inference methods', async () => {
  const previousKey = process.env.OPENAI_API_KEY
  const previousToken = process.env.CODEX_ACCESS_TOKEN
  process.env.OPENAI_API_KEY = 'synthetic-key'
  process.env.CODEX_ACCESS_TOKEN = 'synthetic-token'
  const value = await setup()
  try {
    const notifications: {method: string; params: unknown}[] = []
    const rejected = new Promise<void>(resolve => {
      value.rpc.onNotification((method, params) => {
        notifications.push({method, params})
        if (method === 'fixture/rejectedRequest') resolve()
      })
    })
    assert.deepEqual(await value.rpc.request('account/read'), {home: value.home, cwd: await realpath(value.home),
      hasApiKey: false, hasToken: false, account: null})
    await rejected
    assert.deepEqual(notifications, [
      {method: 'account/rateLimits/updated', params: {usedPercent: 42}},
      {method: 'fixture/rejectedRequest', params: {code: -32601, message: 'Method not found'}},
    ])
    await assert.rejects(value.rpc.request('turn/start'), {code: 'protocol'})
    await assert.rejects(value.rpc.request('thread/start'), {code: 'protocol'})
    if (process.platform !== 'win32') assert.equal((await stat(value.home)).mode & 0o777, 0o700)
    const [slow, fast] = await Promise.all([
      value.rpc.request('account/rateLimits/read', {order: 1, delay: 20}),
      value.rpc.request('account/rateLimits/read', {order: 2, delay: 0}),
    ])
    assert.deepEqual(slow, {primary: {usedPercent: 1}})
    assert.deepEqual(fast, {primary: {usedPercent: 2}})
  } finally {
    await value.close()
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey
    if (previousToken === undefined) delete process.env.CODEX_ACCESS_TOKEN; else process.env.CODEX_ACCESS_TOKEN = previousToken
  }
})

test('quota RPC sanitizes remote errors and preserves the error category', async () => {
  const value = await setup('error')
  try {
    await assert.rejects(value.rpc.request('account/read'), (error: unknown) => {
      assert.ok(error instanceof CodexRpcError)
      assert.equal(error.code, 'remote_error')
      assert.equal(error.rpcCode, -32001)
      assert.equal(error.message.includes('synthetic-private-diagnostic'), false)
      return true
    })
  } finally { await value.close() }
})

for (const mode of ['invalid', 'oversized', 'exit', 'hang']) {
  test(`quota RPC releases pending requests on ${mode}`, async () => {
    const value = await setup(mode, mode === 'oversized' ? 5_000 : 500)
    try {
      await assert.rejects(value.rpc.request('account/read'), {code: mode === 'exit' ? 'closed' : mode === 'hang' ? 'timeout' : 'protocol'})
      await assert.rejects(value.rpc.request('account/read'), {code: 'closed'})
      await value.rpc.close()
      await value.rpc.close()
    } finally { await value.close() }
  })
}

test('closing quota RPC rejects concurrent pending work and missing binary is safe', async () => {
  const value = await setup('hang')
  try {
    const pending = assert.rejects(value.rpc.request('account/read'), {code: 'closed'})
    await value.rpc.close()
    await pending
    await assert.rejects(CodexRpc.start(value.home, {binary: join(value.home, 'missing-codex')}), {code: 'unavailable'})
  } finally { await value.close() }
})

if (process.platform !== 'win32') test('closing quota RPC terminates a child that ignores SIGTERM', async () => {
  const value = await setup('resist')
  try {
    const result = await value.rpc.request('account/read') as {pid: number}
    await value.rpc.close()
    assert.throws(() => process.kill(result.pid, 0), {code: 'ESRCH'})
  } finally { await value.close() }
})

test('quota RPC notifies once when its process exits during browser login', async () => {
  const value = await setup('loginExit')
  try {
    let calls = 0
    const closed = new Promise<void>(resolve => {
      value.rpc.onClose(() => { calls++; resolve() })
    })
    assert.deepEqual(await value.rpc.request('account/login/start', {type: 'chatgpt'}),
      {type: 'chatgpt', loginId: 'fixture-login'})
    await closed
    await value.rpc.close()
    assert.equal(calls, 1)
    await new Promise<void>(resolve => { value.rpc.onClose(resolve) })
    let unsubscribed = false
    const stop = value.rpc.onClose(() => { unsubscribed = true })
    stop()
    await new Promise<void>(resolve => queueMicrotask(resolve))
    assert.equal(unsubscribed, false)
  } finally { await value.close() }
})
