import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectFiles, privacyFindings, validateManifest, validatePackagePaths } from '../scripts/check-package.mjs'

const manifest = {
  name: 'dsh-plugin-chatgpt-siwc', version: '1.2.3',
  files: ['lib', 'cordis.patch.yml', 'README.md', 'PRIVACY.md', 'RELEASING.md', 'LICENSE'],
  publishConfig: { registry: 'https://registry.npmjs.org/', access: 'public', tag: 'latest' },
  scripts: { prepack: 'npm run build' },
}
const runtimeFiles = ['package.json', 'cordis.patch.yml', 'README.md', 'PRIVACY.md', 'RELEASING.md', 'LICENSE',
  'lib/index.js', 'lib/index.d.ts', 'lib/client.js', 'lib/remote.js', 'lib/remote.d.ts']

test('stable releases require exact version tags and the public npm channel', () => {
  assert.doesNotThrow(() => validateManifest(manifest, 'v1.2.3'))
  assert.doesNotThrow(() => validateManifest(manifest))
  for (const tag of ['v1.2.4', '1.2.3', 'v1.2.3-beta.1']) {
    assert.throws(() => validateManifest(manifest, tag), /exactly match/)
  }
  for (const version of ['1.2.3-beta.1', '01.2.3', '1.2', '1.2.3+local']) {
    assert.throws(() => validateManifest({ ...manifest, version }), /stable/)
  }
  assert.throws(() => validateManifest({ ...manifest, private: true }), /public/)
  assert.throws(() => validateManifest({ ...manifest, files: ['.'] }), /allowlist/)
  assert.throws(() => validateManifest({ ...manifest, publishConfig: { access: 'public' } }), /registry/)
})

test('installed packages must not require build hooks or bundle dependency trees', () => {
  for (const hook of ['prepare', 'preinstall', 'install', 'postinstall']) {
    assert.throws(() => validateManifest({ ...manifest, scripts: { [hook]: 'node build.js' } }), /prebuilt/)
  }
  assert.throws(() => validateManifest({ ...manifest, bundledDependencies: ['example'] }), /Bundled/)
})

test('package allowlist accepts runtime outputs and rejects private files and source maps', () => {
  assert.doesNotThrow(() => validatePackagePaths([...runtimeFiles, 'lib/auth/protocol.js']))
  for (const path of ['.env', '.npmrc', 'auth.json', 'AGENTS.md', 'src/index.ts', 'tests/auth.test.ts',
    'lib/auth.json', 'lib/private.key', 'lib/index.js.map', 'lib/.env', 'lib/../private.js',
    'lib/node_modules/token.json', 'lib/a backup.js']) {
    assert.throws(() => validatePackagePaths([...runtimeFiles, path]), /allowlist/)
  }
  assert.throws(() => validatePackagePaths(runtimeFiles.filter(path => path !== 'lib/client.js')), /missing/)
})

test('repository audit rejects private data paths before reading their contents', () => {
  for (const path of ['.env', '.npmrc', '.dsh/config.yml', '.release/private.js',
    'chatgpt-siwc-baselines.json', 'chatgpt-siwc-codex-quota/auth.json',
    'chatgpt-siwc-quota-accounts.json', 'chatgpt-siwc-codex-quota-accounts/fixture/config.toml',
    'lib/node_modules/secret.js']) {
    assert.throws(() => inspectFiles([path]), /forbidden release file/)
  }
  assert.throws(() => inspectFiles(['missing-release-input.js']), error => {
    assert.equal(error.message, 'Unable to inspect a release input; check for missing files or symbolic links')
    assert.deepEqual(privacyFindings(error.message), [])
    return true
  })
})

test('privacy checks detect local paths without returning their contents', () => {
  const paths = [
    '/' + ['Users', 'fixture-owner', 'project'].join('/'),
    '/' + ['home', 'fixture-owner', 'project'].join('/'),
    '/' + ['Volumes', 'fixture-disk', 'project'].join('/'),
    ['C:', 'Users', 'fixture-owner', 'project'].join('\\'),
    ['C:', 'Users', 'fixture-owner', 'project'].join('\\\\'),
  ]
  for (const path of paths) {
    const findings = privacyFindings(`source: ${path}`)
    assert.deepEqual(findings, ['personal absolute path'])
    assert.ok(!JSON.stringify(findings).includes('fixture-owner'))
  }
})

test('privacy checks detect synthetic secrets and embedded identities with redacted output', () => {
  const fixtures = [
    ['sk-' + 'x'.repeat(32), 'access token'],
    ['sk-proj-' + 'x'.repeat(40), 'access token'],
    ['ghp_' + 'x'.repeat(36), 'access token'],
    ['github_pat_' + 'x'.repeat(40), 'access token'],
    ['npm_' + 'x'.repeat(36), 'access token'],
    [['-----BEGIN', 'PRIVATE KEY-----'].join(' '), 'private key'],
    [['https://', 'fixture-user:', 'fixture-password@', 'example.com'].join(''), 'embedded URL credentials'],
    [['eyJ' + 'x'.repeat(12), 'x'.repeat(16), 'x'.repeat(16)].join('.'), 'JWT credential'],
    [['fixture-person', 'fixture-domain.com'].join('@'), 'non-example email address'],
  ]
  for (const [value, label] of fixtures) {
    const findings = privacyFindings(value)
    assert.ok(findings.includes(label))
    assert.ok(!JSON.stringify(findings).includes(value))
  }
})

test('official URLs, runtime placeholders and documented example emails are safe inputs', () => {
  for (const text of ['https://auth.openai.com/api/accounts/authorize', 'http://127.0.0.1:1455/auth/callback',
    'access_token: string', 'Bearer ${accessToken}', 'user@example.com', 'user@example.org',
    'contributors@users.noreply.github.com', 'user@example.test', 'user@account.invalid',
    'user@account.example', 'DSH_HOME/profiles/<name>']) {
    assert.deepEqual(privacyFindings(text), [])
  }
})
