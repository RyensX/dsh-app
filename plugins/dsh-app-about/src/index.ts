import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  RELEASES_API,
  parseGithubRelease,
  readUpdateState,
  shouldCheck,
  updateSnapshot,
  writeUpdateState,
  type PersistedUpdateState,
  type UpdateSnapshot,
} from './update-state.ts'
import {
  appTarget,
  openInstaller,
  prepareInstaller,
  requestAppQuit,
} from './installer.ts'

const REQUEST_TIMEOUT_MS = 15_000

class AboutGateway extends TypertRemoteService {
  private activeCheck: Promise<UpdateSnapshot> | null = null

  constructor(private readonly ctx: Context) {
    super(ctx, 'dshAppAbout')
  }

  @Remote('info')
  async info(): Promise<{ currentVersion: string }> {
    return { currentVersion: currentVersion() }
  }

  @Remote('checkUpdate')
  async checkUpdate(force: boolean): Promise<UpdateSnapshot> {
    if (this.activeCheck !== null) return await this.activeCheck
    const operation = this.performCheck(force)
    this.activeCheck = operation
    try {
      return await operation
    } finally {
      if (this.activeCheck === operation) this.activeCheck = null
    }
  }

  @Remote('dismissUpdate')
  async dismissUpdate(tag: string): Promise<UpdateSnapshot> {
    const state = readUpdateState(statePath())
    if (state.release?.tag === tag) {
      writeUpdateState(statePath(), { ...state, dismissedTag: tag })
      return updateSnapshot(currentVersion(), { ...state, dismissedTag: tag })
    }
    return updateSnapshot(currentVersion(), state)
  }

  @Remote('installUpdate')
  async installUpdate(tag: string): Promise<void> {
    const state = readUpdateState(statePath())
    const release = state.release
    if (release === null || release.tag !== tag) throw new Error('DSH_APP_UPDATE_RELEASE_STALE')
    if (!updateSnapshot(currentVersion(), state).updateAvailable) {
      throw new Error('DSH_APP_UPDATE_NOT_AVAILABLE')
    }
    const target = appTarget(requiredEnvironment('DSH_APP_EDITION'), requiredEnvironment('DSH_APP_TARGET'))
    const installer = await prepareInstaller(release, target, updatesRoot())
    try {
      await openInstaller(installer, target.platform)
    } catch {
      throw new Error('DSH_APP_UPDATE_OPEN_FAILED')
    }
    // 安装包成功交给系统后再退出桌面壳；延迟确保 RPC 响应能先返回客户端。
    requestAppQuit(requiredEnvironment('DSH_APP_CONTROL_REQUEST'))
  }

  private async performCheck(force: boolean): Promise<UpdateSnapshot> {
    const state = readUpdateState(statePath())
    if (!force && !shouldCheck(state, Date.now())) return updateSnapshot(currentVersion(), state)

    const response = await fetch(RELEASES_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `DSH-App/${currentVersion()}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`DSH_APP_UPDATE_REQUEST_FAILED\nHTTP ${response.status}`)
    const release = parseGithubRelease(await response.json())
    const next: PersistedUpdateState = {
      ...state,
      checkedAt: new Date().toISOString(),
      release,
    }
    writeUpdateState(statePath(), next)
    return updateSnapshot(currentVersion(), next)
  }
}

export function apply(ctx: Context): void {
  new AboutGateway(ctx)
}

function currentVersion(): string {
  const value = process.env.DSH_APP_VERSION
  if (value === undefined || value === '') throw new Error('DSH_APP_MISSING_ENVIRONMENT\nDSH_APP_VERSION')
  return value
}

function statePath(): string {
  const config = requiredEnvironment('DSH_APP_CONFIG')
  return join(dirname(config), 'app-update.json')
}

function updatesRoot(): string {
  return join(dirname(requiredEnvironment('DSH_APP_CONFIG')), 'updates')
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`DSH_APP_MISSING_ENVIRONMENT\n${name}`)
  return value
}
