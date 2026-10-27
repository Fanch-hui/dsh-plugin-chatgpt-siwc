import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')

test('artifact upload includes the hidden output directory but only audited tarballs', () => {
  const upload = workflow.split('- name: Preserve the audited package')[1]?.split('\n  publish:')[0]
  assert.ok(upload)
  assert.match(upload, /path: \.release\/\*\.tgz\n/)
  assert.match(upload, /include-hidden-files: true\n/)
  assert.match(upload, /if-no-files-found: error\n/)
  assert.doesNotMatch(upload, /path: (?:\.|\.release)\/?\n/)
})

test('manual workflow verification cannot publish npm packages', () => {
  assert.match(workflow, /\n  workflow_dispatch:\n/)
  const publish = workflow.split('\n  publish:')[1]
  assert.ok(publish)
  assert.match(publish, /if: github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/v'\)/)
  assert.match(publish, /environment: npm/)
  assert.match(publish, /id-token: write/)
  assert.match(publish, /npm publish \.release\/\*\.tgz.*--ignore-scripts/)
})
