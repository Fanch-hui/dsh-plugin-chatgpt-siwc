import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { preparePublicSnapshot, publicRepositoryUrl } from '../scripts/prepare-public.mjs'

const fixtureIdentity = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Release fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
  GIT_COMMITTER_NAME: 'Release fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test',
}
function git(root, ...args) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd: root, env: fixtureIdentity, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
}
function prepare(options) {
  return preparePublicSnapshot({ expectedHead: git(options.root, 'rev-parse', 'HEAD'), ...options })
}
function fixture(t) {
  const parent = realpathSync(tmpdir())
  const directory = mkdtempSync(join(parent, 'siwc-public-test-'))
  t.after(() => {
    assert.equal(dirname(realpathSync(directory)), parent)
    assert.ok(basename(directory).startsWith('siwc-public-test-'))
    rmSync(directory, { recursive: true, force: true })
  })
  const root = join(directory, 'source')
  const repository = join(directory, 'public.git')
  mkdirSync(root)
  git(root, 'init', '--initial-branch=main')
  git(directory, 'init', '--bare', repository)
  writeFileSync(join(root, 'index.js'), 'export const version = 1\n')
  git(root, 'add', 'index.js')
  git(root, 'commit', '-m', 'Private fixture history')
  const privateRoot = git(root, 'rev-parse', 'HEAD')
  writeFileSync(join(root, 'index.js'), 'export const version = 2\n')
  git(root, 'commit', '-am', 'Private fixture update')
  return { root, repository, privateRoot }
}

test('public source URLs are canonical GitHub HTTPS URLs without credential fields', () => {
  assert.equal(publicRepositoryUrl('git+https://github.com/example/plugin.git'),
    'https://github.com/example/plugin.git')
  assert.equal(publicRepositoryUrl('https://github.com/example/plugin'),
    'https://github.com/example/plugin.git')
  for (const url of ['http://github.com/example/plugin', 'https://github.example.test/example/plugin',
    'https://github.com/example/plugin?token=fixture', 'https://github.com/example/plugin#branch',
    ['https://', 'fixture:fixture@', 'github.com/example/plugin'].join(''),
    'https://github.com/example', 'file:fixture', undefined]) {
    assert.throws(() => publicRepositoryUrl(url), /GitHub/)
  }
})

test('first snapshot has no private parents and preparation performs no remote writes', t => {
  const { root, repository, privateRoot } = fixture(t)
  const privateHead = git(root, 'rev-parse', 'HEAD')
  const result = prepare({ root, repository, version: '0.9.2' })
  assert.equal(git(root, 'show', '-s', '--format=%P', result.commit), '')
  assert.equal(git(root, 'rev-parse', `${result.commit}^{tree}`), git(root, 'rev-parse', 'HEAD^{tree}'))
  assert.equal(git(root, 'show', '-s', '--format=%an|%ae|%cn|%ce', result.commit),
    'DSH ChatGPT SIWC contributors|contributors@users.noreply.github.com|DSH ChatGPT SIWC contributors|contributors@users.noreply.github.com')
  assert.equal(git(root, 'rev-parse', 'HEAD'), privateHead)
  assert.equal(git(root, 'rev-parse', 'refs/dsh-public/prepared'), result.commit)
  assert.equal(git(root, 'ls-remote', repository), '')
  assert.equal(spawnSync('git', ['merge-base', '--is-ancestor', privateRoot, result.commit], { cwd: root }).status, 1)
})

test('updates inherit only the public parent and publish tags point at the public snapshot', t => {
  const { root, repository, privateRoot } = fixture(t)
  const first = prepare({ root, repository, version: '0.9.2', mode: 'push' })
  git(root, 'tag', '-a', 'v9.9.9', '-m', 'Private fixture tag')
  git(root, 'config', 'push.followTags', 'true')
  writeFileSync(join(root, 'index.js'), 'export const version = 3\n')
  git(root, 'commit', '-am', 'Another private fixture update')
  const privateHead = git(root, 'rev-parse', 'HEAD')
  const second = prepare({ root, repository, version: '0.9.3', mode: 'release' })
  assert.equal(second.parent, first.commit)
  assert.equal(git(root, 'show', '-s', '--format=%P', second.commit), first.commit)
  assert.equal(git(repository, 'rev-parse', 'refs/heads/main'), second.commit)
  assert.equal(git(repository, 'rev-parse', 'refs/tags/v0.9.3'), second.commit)
  assert.equal(git(repository, 'tag', '--list'), 'v0.9.3')
  assert.equal(git(repository, 'rev-list', '--count', 'main'), '2')
  assert.equal(git(root, 'rev-parse', 'HEAD'), privateHead)
  assert.equal(spawnSync('git', ['merge-base', '--is-ancestor', privateRoot, second.commit], { cwd: root }).status, 1)
  const unchanged = prepare({ root, repository, version: '0.9.3' })
  assert.equal(unchanged.commit, second.commit)
})

test('a clean commit created after audit cannot replace the pinned source', t => {
  const { root, repository } = fixture(t)
  const first = prepare({ root, repository, version: '0.9.2', mode: 'push' })
  const expectedHead = git(root, 'rev-parse', 'HEAD')
  writeFileSync(join(root, 'index.js'), 'export const version = 99\n')
  git(root, 'commit', '-am', 'Concurrent fixture commit after audit')
  assert.throws(() => preparePublicSnapshot({ root, repository, version: '0.9.2', expectedHead,
    mode: 'release' }), /audited source commit changed/)
  assert.equal(git(repository, 'rev-parse', 'refs/heads/main'), first.commit)
  assert.equal(git(repository, 'tag', '--list'), '')
})

test('an existing release tag rejects the main update atomically', t => {
  const { root, repository } = fixture(t)
  const first = prepare({ root, repository, version: '0.9.2', mode: 'release' })
  writeFileSync(join(root, 'index.js'), 'export const version = 3\n')
  git(root, 'commit', '-am', 'Changed source with a conflicting fixture version')
  assert.throws(() => prepare({ root, repository, version: '0.9.2', mode: 'release' }), /Git operation failed/)
  assert.equal(git(repository, 'rev-parse', 'refs/heads/main'), first.commit)
  assert.equal(git(repository, 'rev-parse', 'refs/tags/v0.9.2'), first.commit)
})

test('uncommitted source cannot be prepared or published', t => {
  const { root, repository } = fixture(t)
  writeFileSync(join(root, 'index.js'), 'uncommitted fixture\n')
  assert.throws(() => prepare({ root, repository, version: '0.9.2', mode: 'push' }), /Commit/)
  assert.equal(git(root, 'ls-remote', repository), '')
})
