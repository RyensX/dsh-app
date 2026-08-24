import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import semver from 'semver'
import { run } from './process.mjs'

const COMMIT_PATTERN = /^[a-f0-9]{40}$/u
const TAG_PATTERN = /^dsh-v([0-9A-Za-z.+-]+)$/u
const CHANNELS = new Set(['stable', 'latest'])

export function readDshSubmoduleRepository(root) {
  const modules = resolve(root, '.gitmodules')
  const path = git([
    'config', '--file', modules, '--get', 'submodule.dsh.path',
  ], { cwd: root })
  if (path !== 'dsh') throw new Error(`submodule.dsh.path must be dsh, received: ${path}`)

  const repository = git([
    'config', '--file', modules, '--get', 'submodule.dsh.url',
  ], { cwd: root })
  return validateDshRepository(repository)
}

export function validateDshRepository(repository) {
  if (typeof repository !== 'string' || repository === '') {
    throw new Error('dsh repository URL is missing')
  }
  let url
  try {
    url = new URL(repository)
  } catch {
    throw new Error(`dsh repository URL is invalid: ${repository}`)
  }
  const segments = url.pathname.split('/').filter(Boolean)
  if (
    url.protocol !== 'https:'
    || url.username !== ''
    || url.password !== ''
    || url.search !== ''
    || url.hash !== ''
    || segments.length !== 2
  ) {
    throw new Error(`dsh repository must be an absolute HTTPS Git URL: ${repository}`)
  }
  return repository
}

export function assertDshCommit(commit) {
  if (!COMMIT_PATTERN.test(commit)) throw new Error(`invalid dsh commit: ${commit}`)
}

export function assertDshTag(tag) {
  if (!TAG_PATTERN.test(tag)) throw new Error(`invalid dsh release tag: ${tag}`)
}

export function assertDshBranch(branch) {
  if (
    typeof branch !== 'string'
    || !/^[A-Za-z0-9._/-]+$/u.test(branch)
    || branch.startsWith('-')
    || branch.startsWith('/')
    || branch.endsWith('/')
    || branch.endsWith('.')
    || branch.endsWith('.lock')
    || branch.includes('..')
    || branch.includes('//')
  ) {
    throw new Error(`invalid dsh branch: ${String(branch)}`)
  }
}

export function parseDshRemoteTags(output) {
  const tags = new Map()
  for (const line of output.split(/\r?\n/u)) {
    const [commit, ref] = line.trim().split(/\s+/u)
    if (!commit || !ref || !COMMIT_PATTERN.test(commit)) continue
    const matched = /^refs\/tags\/(dsh-v[^\s^]+)(\^\{\})?$/u.exec(ref)
    if (!matched) continue
    const version = TAG_PATTERN.exec(matched[1])?.[1]
    if (!version || !semver.valid(version)) continue
    const entry = tags.get(matched[1]) ?? { tag: matched[1], version }
    if (matched[2]) entry.peeledCommit = commit
    else entry.directCommit = commit
    tags.set(matched[1], entry)
  }
  return [...tags.values()].flatMap(entry => {
    const commit = entry.peeledCommit ?? entry.directCommit
    return commit === undefined ? [] : [{ tag: entry.tag, version: entry.version, commit }]
  })
}

export function latestDshRelease(releases) {
  const latest = [...releases]
    .sort((left, right) => semver.rcompare(left.version, right.version))[0]
  if (!latest) throw new Error('upstream has no valid dsh-v* tags')
  return latest
}

export function parseDshRemoteHead(output) {
  let branch = null
  let commit = null
  for (const line of output.split(/\r?\n/u)) {
    const symref = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/u.exec(line.trim())
    if (symref) branch = symref[1]
    const direct = /^([a-f0-9]{40})\s+HEAD$/u.exec(line.trim())
    if (direct) commit = direct[1]
  }
  if (branch === null || commit === null) throw new Error('upstream HEAD does not resolve to a branch commit')
  assertDshBranch(branch)
  return { branch, commit }
}

export function checkDshUpdate(repository, currentCommit, currentTag = null, channel = 'stable') {
  validateDshRepository(repository)
  assertDshCommit(currentCommit)
  if (currentTag !== null) assertDshTag(currentTag)
  if (!CHANNELS.has(channel)) throw new Error(`invalid dsh update channel: ${channel}`)
  if (channel === 'latest') {
    const head = parseDshRemoteHead(git(['ls-remote', '--symref', repository, 'HEAD']))
    return {
      channel,
      currentCommit,
      currentTag,
      latestTag: null,
      latestBranch: head.branch,
      latestCommit: head.commit,
      updateAvailable: hasDshUpdate(currentCommit, head.commit),
      upToDate: currentCommit === head.commit,
    }
  }
  const output = git([
    'ls-remote', '--tags', repository, 'refs/tags/dsh-v*',
  ])
  const latest = latestDshRelease(parseDshRemoteTags(output))
  return {
    channel,
    currentCommit,
    currentTag,
    latestTag: latest.tag,
    latestBranch: null,
    latestCommit: latest.commit,
    updateAvailable: hasDshUpdate(currentCommit, latest.commit),
    upToDate: isDshReleaseCurrent(currentCommit, currentTag, latest.commit, latest.tag),
  }
}

export function hasDshUpdate(currentCommit, latestCommit) {
  assertDshCommit(currentCommit)
  assertDshCommit(latestCommit)
  return currentCommit !== latestCommit
}

export function isDshReleaseCurrent(currentCommit, currentTag, latestCommit, latestTag) {
  assertDshCommit(currentCommit)
  assertDshCommit(latestCommit)
  if (currentTag !== null) assertDshTag(currentTag)
  assertDshTag(latestTag)
  return currentCommit === latestCommit && currentTag === latestTag
}

export function readDshCommitTime(sourceRoot, commit) {
  assertDshCommit(commit)
  const value = git(['show', '-s', '--format=%cI', commit], { cwd: sourceRoot })
  if (value === '' || Number.isNaN(new Date(value).getTime())) {
    throw new Error(`dsh commit has an invalid committer time: ${commit}`)
  }
  return value
}

export function readRemoteDshCommitTime({ repository, commit, tag = null, branch = null }) {
  validateDshRepository(repository)
  assertDshCommit(commit)
  if (tag !== null) assertDshTag(tag)
  if (branch !== null) assertDshBranch(branch)
  if ((tag === null) === (branch === null)) {
    throw new Error('remote dsh commit time requires exactly one Tag or branch')
  }

  // ls-remote 不包含提交时间；只浅拉取目标 Commit 元数据，不检出源码或触发构建。
  const temporary = mkdtempSync(resolve(tmpdir(), 'dsh-app-update-metadata-'))
  const metadataRoot = resolve(temporary, 'repository.git')
  try {
    git(['init', '--quiet', '--bare', metadataRoot])
    const ref = tag !== null ? `refs/tags/${tag}` : `refs/heads/${branch}`
    git([
      'fetch', '--quiet', '--depth=1', '--filter=tree:0', '--no-tags', repository, ref,
    ], { cwd: metadataRoot })
    const fetchedCommit = git(['rev-parse', 'FETCH_HEAD^{commit}'], { cwd: metadataRoot })
    if (fetchedCommit !== commit) {
      throw new Error(`dsh ref ${tag ?? branch} resolved to ${fetchedCommit}, expected ${commit}`)
    }
    return readDshCommitTime(metadataRoot, fetchedCommit)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

export function syncDshSource({ repository, commit, tag, branch = null, destination }) {
  validateDshRepository(repository)
  assertDshCommit(commit)
  if (tag !== null) assertDshTag(tag)
  if (branch !== null) assertDshBranch(branch)
  if (tag !== null && branch !== null) throw new Error('dsh source cannot select both a tag and a branch')

  if (existsSync(destination)) {
    if (!existsSync(resolve(destination, '.git'))) {
      throw new Error(`persistent dsh source is not a Git checkout: ${destination}`)
    }
    const origin = git(['remote', 'get-url', 'origin'], { cwd: destination })
    if (origin !== repository) {
      throw new Error(`persistent dsh source origin changed: ${origin}`)
    }
    // 构建会修改受跟踪的 workspace 文件；同步前恢复它们，但保留 ignored 依赖与构建缓存。
    git(['reset', '--hard', 'HEAD'], { cwd: destination })
    git(['clean', '-fd'], { cwd: destination })
  } else {
    mkdirSync(resolve(destination, '..'), { recursive: true })
    git(['init', '--quiet', destination])
    git(['remote', 'add', 'origin', repository], { cwd: destination })
  }
  const ref = tag !== null ? `refs/tags/${tag}` : branch !== null ? `refs/heads/${branch}` : commit
  git(['fetch', '--quiet', '--depth=1', '--no-tags', 'origin', ref], { cwd: destination })
  const fetchedCommit = git(['rev-parse', 'FETCH_HEAD^{commit}'], { cwd: destination })
  if (fetchedCommit !== commit) {
    throw new Error(`dsh ref ${tag ?? branch ?? commit} resolved to ${fetchedCommit}, expected ${commit}`)
  }
  git(['checkout', '--quiet', '--force', '--detach', commit], { cwd: destination })
  const checkedOutCommit = git(['rev-parse', 'HEAD'], { cwd: destination })
  if (checkedOutCommit !== commit) throw new Error(`dsh checkout resolved to unexpected commit: ${checkedOutCommit}`)
  return realpathSync(destination)
}

export function createDshBuildWorktree({ sourceRoot, commit, destination }) {
  assertDshCommit(commit)
  if (!existsSync(resolve(sourceRoot, '.git'))) {
    throw new Error(`persistent dsh source is not a Git checkout: ${sourceRoot}`)
  }
  if (existsSync(destination)) {
    throw new Error(`temporary dsh build worktree already exists: ${destination}`)
  }

  // 上次进程若异常退出，staging 可能已被删除，但 Git 仍记录着旧 worktree。
  git(['worktree', 'prune', '--expire', 'now'], { cwd: sourceRoot })
  mkdirSync(resolve(destination, '..'), { recursive: true })
  try {
    git(['worktree', 'add', '--quiet', '--detach', destination, commit], { cwd: sourceRoot })
    const checkedOutCommit = git(['rev-parse', 'HEAD'], { cwd: destination })
    if (checkedOutCommit !== commit) {
      throw new Error(`temporary dsh worktree resolved to unexpected commit: ${checkedOutCommit}`)
    }
    return realpathSync(destination)
  } catch (error) {
    if (existsSync(destination)) {
      removeDshBuildWorktree({ sourceRoot, destination })
    }
    throw error
  }
}

export function removeDshBuildWorktree({ sourceRoot, destination }) {
  if (existsSync(destination)) {
    git(['worktree', 'remove', '--force', destination], { cwd: sourceRoot })
  }
  git(['worktree', 'prune', '--expire', 'now'], { cwd: sourceRoot })
}

function git(args, options = {}) {
  try {
    return run('git', args, {
      ...options,
      capture: true,
      env: {
        ...process.env,
        ...options.env,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'Never',
      },
    })
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error('Git is required to retrieve dsh, but no git executable was found in PATH')
    }
    throw error
  }
}
