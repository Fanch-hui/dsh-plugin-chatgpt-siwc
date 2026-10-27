import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {QuotaAccounts, quotaHome} from '../src/quota/accounts.js'

async function fixture() {
  const profile = await mkdtemp(join(tmpdir(), 'dsh-quota-accounts-'))
  return {profile, filename: join(profile, 'chatgpt-siwc-quota-accounts.json'),
    async close() { await rm(profile, {recursive: true, force: true}) }}
}

test('legacy login discovery and old registry identifiers remain readable', async () => {
  const value = await fixture()
  try {
    const legacy = quotaHome(value.profile, 'legacy')
    await mkdir(legacy, {recursive: true})
    await writeFile(join(legacy, 'auth.json'), '{}')
    const accounts = new QuotaAccounts(value.profile)
    assert.deepEqual(await accounts.read(), [{id: 'legacy'}])
    const id = randomUUID()
    await writeFile(value.filename, JSON.stringify({version: 1, accounts: ['legacy', id]}))
    assert.deepEqual(await accounts.read(), [{id: 'legacy'}, {id}])
    await accounts.setSource(id, 'a'.repeat(64))
    assert.deepEqual(JSON.parse(await readFile(value.filename, 'utf8')), {
      version: 2, accounts: [{id: 'legacy'}, {id, sourceKey: 'a'.repeat(64)}],
    })
    if (process.platform !== 'win32') assert.equal((await stat(value.filename)).mode & 0o777, 0o600)
  } finally { await value.close() }
})

test('independent writers retain other slots and reject duplicate quota sources', async () => {
  const value = await fixture()
  try {
    const a = new QuotaAccounts(value.profile)
    const b = new QuotaAccounts(value.profile)
    const first = randomUUID()
    const second = randomUUID()
    await Promise.all([a.add(first), b.add(second)])
    await a.setSource(first, 'a'.repeat(64))
    await assert.rejects(b.setSource(second, 'a'.repeat(64)), /已连接/)
    await b.setSource(second, 'b'.repeat(64))
    await a.remove(first)
    assert.deepEqual(await b.read(), [{id: second, sourceKey: 'b'.repeat(64)}])
  } finally { await value.close() }
})

test('invalid slot ids and malformed or excessive registry data fail closed', async () => {
  const value = await fixture()
  try {
    const accounts = new QuotaAccounts(value.profile)
    assert.throws(() => quotaHome(value.profile, '../outside'), /标识无效/)
    await assert.rejects(accounts.add('../outside'), /标识无效/)
    await writeFile(value.filename, JSON.stringify({version: 2, accounts: [{id: '../outside'}]}))
    await assert.rejects(accounts.read(), /读取失败/)
    await writeFile(value.filename, 'x'.repeat(32 * 1024 + 1))
    await assert.rejects(accounts.read(), /读取失败/)
  } finally { await value.close() }
})
