import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageFiles = ['lib', 'cordis.patch.yml', 'README.md', 'PRIVACY.md', 'RELEASING.md', 'LICENSE']
const requiredFiles = ['package.json', 'cordis.patch.yml', 'README.md', 'PRIVACY.md', 'RELEASING.md', 'LICENSE',
  'lib/index.js', 'lib/index.d.ts', 'lib/client.js', 'lib/remote.js', 'lib/remote.d.ts']
const forbiddenPath = /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.credentials[^/]*|auth\.json|AGENTS\.md|chatgpt-siwc-[^/]*\.json|[^/]*\.(?:pem|key|tgz|log|map))$/i
const privateDirectory = /(?:^|\/)(?:\.git|\.dsh|\.release|node_modules|chatgpt-siwc-codex-quota(?:-accounts)?)(?:\/|$)/i

function isForbiddenPath(path) {
  return forbiddenPath.test(path) || privateDirectory.test(path)
}
const privacyRules = [
  ['personal absolute path', /(?:\/Users\/|\/home\/|\/Volumes\/)[A-Za-z0-9._-]+|[A-Za-z]:\\{1,2}Users\\{1,2}[A-Za-z0-9._-]+/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
  ['access token', /\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|npm_[A-Za-z0-9]{30,})\b/],
  ['embedded URL credentials', /https?:\/\/[^\s/"'<>]+:[^\s/"'<>]+@/],
  ['JWT credential', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
]

export function privacyFindings(text) {
  const findings = privacyRules.filter(([, pattern]) => pattern.test(text)).map(([label]) => label)
  const emails = text.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g) ?? []
  if (emails.some(email => !/@(?:example\.(?:com|net|org)|[^@]+\.(?:test|invalid|example)|users\.noreply\.github\.com)$/i.test(email))) {
    findings.push('non-example email address')
  }
  return findings
}

export function validateManifest(manifest, tag) {
  if (manifest.name !== 'dsh-plugin-chatgpt-siwc' || manifest.private) {
    throw new Error('Expected a public dsh-plugin-chatgpt-siwc package')
  }
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(manifest.version)) {
    throw new Error('Release version must be a stable X.Y.Z version')
  }
  if (tag !== undefined && tag !== `v${manifest.version}`) {
    throw new Error('Release tag must exactly match the package version')
  }
  if (JSON.stringify(manifest.files) !== JSON.stringify(packageFiles)) {
    throw new Error('Package files must use the reviewed allowlist')
  }
  if (manifest.publishConfig?.registry !== 'https://registry.npmjs.org/'
    || manifest.publishConfig?.access !== 'public' || manifest.publishConfig?.tag !== 'latest') {
    throw new Error('Publishing must use the public npm registry and latest channel')
  }
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
    if (manifest.scripts?.[hook]) throw new Error('Installation must use prebuilt artifacts without build hooks')
  }
  if (manifest.bundleDependencies || manifest.bundledDependencies) {
    throw new Error('Bundled dependency directories are not part of the release allowlist')
  }
}

export function validatePackagePaths(paths) {
  for (const path of paths) {
    const rootFile = requiredFiles.includes(path) && !path.startsWith('lib/')
    const compiledFile = /^lib\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:js|d\.ts)$/.test(path)
    if ((!rootFile && !compiledFile) || isForbiddenPath(path)) {
      throw new Error('Package contains a file outside the release allowlist')
    }
  }
  if (requiredFiles.some(path => !paths.includes(path))) {
    throw new Error('Package is missing a required runtime entry or document')
  }
}

function capture(command, args) {
  try {
    return execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    // Tool output can contain local configuration; never echo it into release logs.
    throw new Error('Release inspection command failed; check the local tool configuration')
  }
}

export function inspectFiles(paths) {
  const issues = []
  for (const path of paths) {
    if (isForbiddenPath(path)) {
      issues.push(`${path}: forbidden release file`)
      continue
    }
    let text
    try {
      const absolute = resolve(root, path)
      if (!absolute.startsWith(`${root}${sep}`) || !lstatSync(absolute).isFile()
        || !realpathSync(absolute).startsWith(`${realpathSync(root)}${sep}`)) {
        throw new Error('Invalid release input')
      }
      text = readFileSync(absolute, 'utf8')
    } catch {
      throw new Error('Unable to inspect a release input; check for missing files or symbolic links')
    }
    for (const finding of privacyFindings(text)) issues.push(`${path}: ${finding}`)
  }
  if (issues.length) throw new Error(`Privacy review required (matched values redacted):\n${issues.join('\n')}`)
}

export function checkPackage(tag) {
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  validateManifest(manifest, tag)
  const npm = process.env.npm_execpath
  const command = npm ? process.execPath : 'npm'
  const args = [...(npm ? [npm] : []), 'pack', '--dry-run', '--json', '--ignore-scripts']
  const packages = JSON.parse(capture(command, args))
  if (packages.length !== 1) throw new Error('Expected exactly one release package')
  const paths = packages[0].files.map(file => file.path)
  validatePackagePaths(paths)
  const tracked = capture('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
    .split('\0').filter(Boolean)
  inspectFiles([...new Set([...tracked, ...paths])])
  console.log(`Release audit passed: ${paths.length} package files; repository and package privacy checks passed.`)
  return packages[0]
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2)
    if (args.length > 1) throw new Error('Usage: node scripts/check-package.mjs [vX.Y.Z]')
    checkPackage(args[0])
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Release inspection failed')
    process.exitCode = 1
  }
}
