import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import semver from 'semver'

export const APP_REPOSITORY = 'https://github.com/RyensX/dsh-app'
export const RELEASES_API = 'https://api.github.com/repos/RyensX/dsh-app/releases/latest'
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

export type ReleaseInfo = {
  tag: string
  version: string
  name: string
  body: string
  url: string
  publishedAt: string | null
  assets: string[]
}

export type PersistedUpdateState = {
  schemaVersion: 1
  checkedAt: string | null
  dismissedTag: string | null
  release: ReleaseInfo | null
}

export type UpdateSnapshot = {
  currentVersion: string
  checkedAt: string | null
  dismissed: boolean
  release: ReleaseInfo | null
  updateAvailable: boolean
}

export function emptyUpdateState(): PersistedUpdateState {
  return { schemaVersion: 1, checkedAt: null, dismissedTag: null, release: null }
}

export function readUpdateState(path: string): PersistedUpdateState {
  if (!existsSync(path)) return emptyUpdateState()
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return parseUpdateState(value)
  } catch {
    throw new Error('DSH_APP_UPDATE_STATE_INVALID')
  }
}

export function writeUpdateState(path: string, state: PersistedUpdateState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${process.pid}`
  const backup = `${path}.previous-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  let movedPrevious = false
  try {
    try {
      renameSync(path, backup)
      movedPrevious = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    renameSync(temporary, path)
    rmSync(backup, { force: true })
  } catch (error) {
    rmSync(temporary, { force: true })
    if (movedPrevious) {
      try { renameSync(backup, path) } catch {}
    }
    throw error
  }
}

export function shouldCheck(state: PersistedUpdateState, now: number): boolean {
  if (state.checkedAt === null) return true
  const checkedAt = Date.parse(state.checkedAt)
  return !Number.isFinite(checkedAt) || now - checkedAt >= CHECK_INTERVAL_MS
}

export function updateSnapshot(
  currentVersion: string,
  state: PersistedUpdateState,
): UpdateSnapshot {
  const releaseVersion = state.release === null ? null : normalizedVersion(state.release.tag)
  const installedVersion = normalizedVersion(currentVersion)
  const updateAvailable = releaseVersion !== null
    && installedVersion !== null
    && semver.gt(releaseVersion, installedVersion)
  return {
    currentVersion,
    checkedAt: state.checkedAt,
    dismissed: updateAvailable && state.dismissedTag === state.release?.tag,
    release: state.release,
    updateAvailable,
  }
}

export function parseGithubRelease(value: unknown): ReleaseInfo {
  if (!isRecord(value) || typeof value.tag_name !== 'string' || value.tag_name === '') {
    throw new Error('DSH_APP_RELEASE_INVALID')
  }
  const tag = value.tag_name
  const version = normalizedVersion(tag)
  if (version === null) throw new Error('DSH_APP_RELEASE_INVALID')
  const assets = Array.isArray(value.assets)
    ? value.assets.flatMap(asset => (
        isRecord(asset) && typeof asset.name === 'string' && asset.name !== '' ? [asset.name] : []
      ))
    : []
  return {
    tag,
    version,
    name: typeof value.name === 'string' && value.name !== '' ? value.name : tag,
    body: typeof value.body === 'string' ? value.body.slice(0, 50_000) : '',
    // Release 链接来自固定仓库和 GitHub 返回的 Tag，不接受远端响应中的任意 URL。
    url: `${APP_REPOSITORY}/releases/tag/${encodeURIComponent(tag)}`,
    publishedAt: typeof value.published_at === 'string' ? value.published_at : null,
    assets,
  }
}

function parseUpdateState(value: unknown): PersistedUpdateState {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new Error('shape')
  const checkedAt = value.checkedAt === null || typeof value.checkedAt === 'string'
    ? value.checkedAt
    : null
  const dismissedTag = value.dismissedTag === null || typeof value.dismissedTag === 'string'
    ? value.dismissedTag
    : null
  const release = value.release === null ? null : parsePersistedRelease(value.release)
  return { schemaVersion: 1, checkedAt, dismissedTag, release }
}

function parsePersistedRelease(value: unknown): ReleaseInfo {
  if (!isRecord(value)
    || typeof value.tag !== 'string'
    || typeof value.name !== 'string'
    || typeof value.body !== 'string'
    || typeof value.url !== 'string'
    || (value.publishedAt !== null && typeof value.publishedAt !== 'string')) {
    throw new Error('release')
  }
  const version = normalizedVersion(value.tag)
  if (version === null) throw new Error('release')
  return {
    tag: value.tag,
    version,
    name: value.name,
    body: value.body,
    // 旧缓存也重新拼接 URL，避免持久化文件被修改后打开任意地址。
    url: `${APP_REPOSITORY}/releases/tag/${encodeURIComponent(value.tag)}`,
    publishedAt: value.publishedAt,
    assets: Array.isArray(value.assets)
      ? value.assets.filter((asset): asset is string => typeof asset === 'string')
      : [],
  }
}

function normalizedVersion(value: string): string | null {
  return semver.valid(value.trim().replace(/^v/u, ''))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
