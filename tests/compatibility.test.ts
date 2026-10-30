import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const peerManifest = { ...manifest, engines: { node: manifest.engines.node } }

test('DSH boot accepts supported and newer desktop runtimes', () => {
  for (const version of ['0.2.1-rc.3', '0.2.1-rc.4', '0.2.1-rc.5', '0.2.1-rc.6',
    '0.2.1', '0.2.2-alpha.2', '0.3.0-alpha.1', '1.0.0']) {
    assert.equal(evaluatePluginCompatibility(manifest, {}, version), undefined, version)
    assert.equal(evaluatePluginCompatibility(peerManifest, {}, version), undefined, `peers: ${version}`)
  }
})

test('DSH boot enforces the minimum required runtime', () => {
  for (const version of ['0.2.0', '0.2.1-alpha.5', '0.2.1-rc.2']) {
    for (const candidate of [manifest, peerManifest]) {
      const issue = evaluatePluginCompatibility(candidate, {}, version)
      assert.ok(issue, version)
      assert.equal(issue.runtimeVersion, version)
      assert.equal(issue.exempted, false)
    }
  }
})

test('the previous exact engine requirement reproduces the desktop upgrade rejection', () => {
  const issue = evaluatePluginCompatibility({
    ...manifest, engines: { ...manifest.engines, dsh: '0.2.1-rc.3' },
  }, {}, '0.2.1-rc.5')
  assert.deepEqual(issue?.requirements, { 'engines.dsh': '0.2.1-rc.3' })
  assert.equal(issue?.exempted, false)
})
