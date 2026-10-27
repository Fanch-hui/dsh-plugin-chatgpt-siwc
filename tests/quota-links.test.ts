import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QuotaLinks } from '../src/quota/links.js'

const account = 'a'.repeat(64)
const other = 'b'.repeat(64)
const source = 'c'.repeat(64)
const temporary = 'd'.repeat(64)
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-quota-links-'))
  return {root, filename: join(root, 'chatgpt-siwc-quota-links.json'),
    async close() { await rm(root, {recursive: true, force: true}) }}
}

test('confirmed persistent links survive restart and use owner-only permissions', async () => {
  const value = await fixture()
  try {
    const links = new QuotaLinks(value.root)
    await links.load()
    assert.equal(links.matches(account, source), false)
    await links.bind(account, source, true)
    const restarted = new QuotaLinks(value.root)
    await restarted.load()
    assert.equal(restarted.matches(account, source), true)
    assert.equal(restarted.matches(other, source), false)
    if (process.platform !== 'win32') assert.equal((await stat(value.filename)).mode & 0o777, 0o600)
  } finally { await value.close() }
})

test('ephemeral confirmation replaces a prior persistent link only in the current process', async () => {
  const value = await fixture()
  try {
    const links = new QuotaLinks(value.root)
    await links.bind(account, source, true)
    await links.bind(account, temporary, false)
    assert.equal(links.matches(account, temporary), true)
    assert.equal(links.matches(account, source), false)
    const restarted = new QuotaLinks(value.root)
    await restarted.load()
    assert.equal(restarted.matches(account, temporary), false)
    assert.equal(restarted.matches(account, source), false)
  } finally { await value.close() }
})

test('unlink and clear remove both persistent and ephemeral associations', async () => {
  const value = await fixture()
  try {
    const links = new QuotaLinks(value.root)
    await links.bind(account, source, true)
    await links.bind(other, temporary, false)
    await links.unlink(account)
    assert.equal(links.matches(account, source), false)
    assert.equal(links.matches(other, temporary), true)
    await links.bind(account, source, true)
    await links.clear()
    assert.equal(links.matches(account, source), false)
    assert.equal(links.matches(other, temporary), false)
    const restarted = new QuotaLinks(value.root)
    await restarted.load()
    assert.equal(restarted.matches(account, source), false)
  } finally { await value.close() }
})

test('independent writers re-read under the lock and preserve each other’s associations', async () => {
  const value = await fixture()
  try {
    const one = new QuotaLinks(value.root)
    const two = new QuotaLinks(value.root)
    await Promise.all([one.load(), two.load()])
    await Promise.all([one.bind(account, source, true), two.bind(other, temporary, true)])
    const restarted = new QuotaLinks(value.root)
    await restarted.load()
    assert.equal(restarted.matches(account, source), true)
    assert.equal(restarted.matches(other, temporary), true)
    await one.unlink(account)
    await two.bind(other, source, true)
    const final = new QuotaLinks(value.root)
    await final.load()
    assert.equal(final.matches(account, source), false)
    assert.equal(final.matches(other, source), true)
  } finally { await value.close() }
})

test('unknown root fields are stripped on write and malformed files fail closed', async () => {
  const value = await fixture()
  try {
    await writeFile(value.filename, JSON.stringify({version: 1, links: {[account]: source}, note: 'private-fixture'}))
    const links = new QuotaLinks(value.root)
    await links.load()
    assert.equal(links.matches(account, source), true)
    await links.bind(other, temporary, true)
    assert.equal((await readFile(value.filename, 'utf8')).includes('private-fixture'), false)
    await writeFile(value.filename, '{private-fixture-invalid')
    const broken = new QuotaLinks(value.root)
    await assert.rejects(broken.load(), /额度关联记录读取失败/)
    assert.equal(broken.matches(account, source), false)
    await assert.rejects(broken.bind(account, source, true), /额度关联记录读取失败/)
    assert.equal(await readFile(value.filename, 'utf8'), '{private-fixture-invalid')
  } finally { await value.close() }
})

test('input identifiers and oversized or excessive metadata are rejected', async () => {
  const value = await fixture()
  try {
    const links = new QuotaLinks(value.root)
    await assert.rejects(links.bind('raw-identifier', source, true), /标识格式无效/)
    assert.equal(links.matches('raw-identifier', source), false)
    await writeFile(value.filename, ' '.repeat(64 * 1024 + 1))
    await assert.rejects(new QuotaLinks(value.root).load(), /读取失败/)
    const excessive = Object.fromEntries(Array.from({length: 129}, (_, i) => [i.toString(16).padStart(64, '0'), source]))
    await writeFile(value.filename, JSON.stringify({version: 1, links: excessive}))
    await assert.rejects(new QuotaLinks(value.root).load(), /读取失败/)
  } finally { await value.close() }
})

test('the binding limit also covers temporary associations without changing committed links', async () => {
  const value = await fixture()
  try {
    const entries = Object.fromEntries(Array.from({length: 128}, (_, i) => [i.toString(16).padStart(64, '0'), source]))
    const serialized = JSON.stringify({version: 1, links: entries})
    await writeFile(value.filename, serialized)
    const links = new QuotaLinks(value.root)
    await links.load()
    await assert.rejects(links.bind(account, temporary, false), /数量已达上限/)
    assert.equal(links.matches(account, temporary), false)
    assert.equal(await readFile(value.filename, 'utf8'), serialized)
  } finally { await value.close() }
})
