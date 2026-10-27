import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { checkPackage } from './check-package.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const publicIdentity = {
  GIT_AUTHOR_NAME: 'DSH ChatGPT SIWC contributors',
  GIT_AUTHOR_EMAIL: 'contributors@users.noreply.github.com',
  GIT_COMMITTER_NAME: 'DSH ChatGPT SIWC contributors',
  GIT_COMMITTER_EMAIL: 'contributors@users.noreply.github.com',
}

export function publicRepositoryUrl(value) {
  let url
  try { url = new URL(value?.replace(/^git\+/, '')) } catch {
    throw new Error('Configure a public GitHub HTTPS repository before publishing source')
  }
  const parts = url.pathname.replace(/\.git$/, '').split('/').filter(Boolean)
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port
    || url.username || url.password || url.search || url.hash || parts.length !== 2
    || parts.some(part => !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part))) {
    throw new Error('Source publishing requires a GitHub HTTPS URL without embedded credentials')
  }
  return `https://github.com/${parts.join('/')}.git`
}

function git(root, args, options = {}) {
  try {
    return execFileSync('git', args, {
      cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options,
    }).trim()
  } catch {
    // Git diagnostics can contain local identities and credential-helper details.
    throw new Error('Public snapshot Git operation failed; check repository access and retry')
  }
}

export function preparePublicSnapshot({ root, repository, version, expectedHead, mode = 'prepare' }) {
  if (!['prepare', 'push', 'release'].includes(mode)
    || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)) {
    throw new Error('Expected a supported publication mode and stable X.Y.Z version')
  }
  if (realpathSync(git(root, ['rev-parse', '--show-toplevel'])) !== realpathSync(root)) {
    throw new Error('Run source publication from the project repository root')
  }
  if (git(root, ['status', '--porcelain', '--untracked-files=normal'])) {
    throw new Error('Commit the reviewed source changes before preparing a public snapshot')
  }
  if (!/^[a-f0-9]{40,64}$/.test(expectedHead ?? '') || git(root, ['rev-parse', 'HEAD']) !== expectedHead) {
    throw new Error('The audited source commit changed; rerun the release checks')
  }
  const privateHead = expectedHead
  const tree = git(root, ['rev-parse', `${expectedHead}^{tree}`])
  const listing = git(root, ['ls-remote', '--heads', repository, 'refs/heads/main'])
  let parent
  if (listing) {
    if (!/^[a-f0-9]{40,64}\s+refs\/heads\/main$/.test(listing)) {
      throw new Error('Expected a single public main branch')
    }
    git(root, ['fetch', '--no-tags', '--no-write-fetch-head', repository,
      '+refs/heads/main:refs/dsh-public/main'])
    parent = git(root, ['rev-parse', 'refs/dsh-public/main'])
  }
  const parentTree = parent && git(root, ['rev-parse', `${parent}^{tree}`])
  const commit = parentTree === tree ? parent : git(root,
    ['-c', 'commit.gpgsign=false', 'commit-tree', tree, ...(parent ? ['-p', parent] : [])],
    { input: `Release ${version}\n`, env: { ...process.env, ...publicIdentity } })
  git(root, ['update-ref', 'refs/dsh-public/prepared', commit])
  if (git(root, ['rev-parse', 'HEAD']) !== privateHead) {
    throw new Error('The development branch changed during snapshot preparation')
  }
  if (mode !== 'prepare') {
    const refs = [`${commit}:refs/heads/main`]
    if (mode === 'release') refs.push(`${commit}:refs/tags/v${version}`)
    git(root, ['push', '--atomic', '--no-follow-tags', repository, ...refs])
  }
  return { commit, parent, version, mode }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2)
    if (args.length > 1 || (args.length && !['--push', '--release'].includes(args[0]))) {
      throw new Error('Usage: node scripts/prepare-public.mjs [--push|--release]')
    }
    const expectedHead = git(projectRoot, ['rev-parse', 'HEAD'])
    const manifest = JSON.parse(git(projectRoot, ['show', `${expectedHead}:package.json`]))
    const repository = publicRepositoryUrl(manifest.repository?.url)
    checkPackage()
    const mode = args[0] === '--release' ? 'release' : args[0] === '--push' ? 'push' : 'prepare'
    const result = preparePublicSnapshot({ root: projectRoot, repository, version: manifest.version, expectedHead, mode })
    console.log(`Public snapshot ${result.commit.slice(0, 12)}: ${mode} completed for ${result.version}.`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Public snapshot preparation failed')
    process.exitCode = 1
  }
}
