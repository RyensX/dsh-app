import { spawn } from 'node:child_process'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { APP_REPOSITORY, type ReleaseInfo } from './update-state.ts'

const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000
const QUIT_ACK_DELAY_MS = 750

export type AppTarget = {
  edition: 'bundled' | 'lite'
  platform: 'macos' | 'windows'
  arch: 'arm64' | 'x64'
}

export function appTarget(edition: string, target: string): AppTarget {
  if (edition !== 'bundled' && edition !== 'lite') throw new Error('DSH_APP_UPDATE_TARGET_INVALID')
  switch (target) {
    case 'aarch64-apple-darwin':
      return { edition, platform: 'macos', arch: 'arm64' }
    case 'x86_64-apple-darwin':
      return { edition, platform: 'macos', arch: 'x64' }
    case 'x86_64-pc-windows-msvc':
      return { edition, platform: 'windows', arch: 'x64' }
    default:
      throw new Error('DSH_APP_UPDATE_TARGET_INVALID')
  }
}

export function installerFilename(release: ReleaseInfo, target: AppTarget): string {
  const extension = target.platform === 'macos' ? 'dmg' : 'exe'
  return `dsh-app-${target.edition}-${release.version}-${target.platform}-${target.arch}.${extension}`
}

export async function prepareInstaller(
  release: ReleaseInfo,
  target: AppTarget,
  updatesRoot: string,
): Promise<string> {
  const filename = installerFilename(release, target)
  if (!release.assets.includes(filename)) throw new Error('DSH_APP_UPDATE_ASSET_MISSING')
  const directory = join(updatesRoot, release.tag)
  const destination = join(directory, filename)
  if (existsSync(destination)) return destination

  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = `${destination}.download-${process.pid}`
  const url = `${APP_REPOSITORY}/releases/download/${encodeURIComponent(release.tag)}/${encodeURIComponent(filename)}`
  const response = await fetch(url, {
    headers: { 'User-Agent': 'DSH-App-Updater' },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  })
  if (!response.ok || response.body === null) {
    throw new Error(`DSH_APP_UPDATE_DOWNLOAD_FAILED\nHTTP ${response.status}`)
  }
  try {
    await pipeline(
      Readable.fromWeb(response.body as never),
      createWriteStream(temporary, { flags: 'wx', mode: 0o700 }),
    )
    renameSync(temporary, destination)
    return destination
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

export async function openInstaller(path: string, platform: AppTarget['platform']): Promise<void> {
  const child = platform === 'macos'
    ? spawn('open', [path], { detached: true, stdio: 'ignore' })
    : spawn(path, [], { detached: true, stdio: 'ignore', windowsHide: false })
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  child.unref()
}

export function requestAppQuit(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify({
    schemaVersion: 1,
    action: 'quit',
    notBeforeMs: Date.now() + QUIT_ACK_DELAY_MS,
  }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  rmSync(path, { force: true })
  renameSync(temporary, path)
}
