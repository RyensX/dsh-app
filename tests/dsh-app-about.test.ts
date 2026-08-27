import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { discoverPlugins } from '../scripts/lib/plugins.mjs'
import {
  APP_REPOSITORY,
  CHECK_INTERVAL_MS,
  emptyUpdateState,
  parseGithubRelease,
  readUpdateState,
  shouldCheck,
  updateSnapshot,
  writeUpdateState,
} from '../plugins/dsh-app-about/src/update-state.ts'
import {
  appTarget,
  installerFilename,
} from '../plugins/dsh-app-about/src/installer.ts'

describe('dsh-app-about plugin', () => {
  it('is packaged for both desktop editions with settings and sidebar clients', () => {
    const plugin = discoverPlugins(join(process.cwd(), 'plugins'))
      .find(candidate => candidate.manifest.id === 'dsh-app-about')
    expect(plugin?.manifest).toMatchObject({
      enabled: true,
      targets: ['macos', 'windows'],
      editions: ['bundled', 'lite'],
      client: { immediately: true },
    })
    expect(plugin?.manifest.client?.inject).toContain('@deepseek-ai/dsh-client-ui-settings')
    expect(plugin?.manifest.client?.inject).toContain('@deepseek-ai/dsh-client-ui-sidebar')
  })

  it('compares strict release SemVer and rebuilds the fixed GitHub release URL', () => {
    const release = parseGithubRelease({
      tag_name: 'v1.2.0',
      name: 'DSH App 1.2',
      body: 'New behavior',
      published_at: '2026-08-24T00:00:00Z',
      assets: [{ name: 'dsh-app-lite-1.2.0-macos-arm64.dmg' }],
      html_url: 'https://example.invalid/untrusted',
    })
    expect(release.url).toBe(`${APP_REPOSITORY}/releases/tag/v1.2.0`)
    expect(release.assets).toEqual(['dsh-app-lite-1.2.0-macos-arm64.dmg'])
    expect(installerFilename(release, appTarget('lite', 'aarch64-apple-darwin')))
      .toBe('dsh-app-lite-1.2.0-macos-arm64.dmg')
    expect(installerFilename(release, appTarget('bundled', 'x86_64-pc-windows-msvc')))
      .toBe('dsh-app-bundled-1.2.0-windows-x64.exe')
    expect(updateSnapshot('1.1.9', {
      schemaVersion: 1,
      checkedAt: null,
      dismissedTag: null,
      release,
    }).updateAvailable).toBe(true)
    expect(updateSnapshot('1.2.0', {
      schemaVersion: 1,
      checkedAt: null,
      dismissedTag: null,
      release,
    }).updateAvailable).toBe(false)
  })

  it('checks after 24 hours and persists dismissal independently of config.json', () => {
    const now = Date.parse('2026-08-24T12:00:00Z')
    const state = { ...emptyUpdateState(), checkedAt: new Date(now).toISOString() }
    expect(shouldCheck(state, now + CHECK_INTERVAL_MS - 1)).toBe(false)
    expect(shouldCheck(state, now + CHECK_INTERVAL_MS)).toBe(true)

    const root = join(process.env.TMPDIR ?? '/tmp', `dsh-app-about-${process.pid}-${Math.random()}`)
    mkdirSync(root, { recursive: true })
    const path = join(root, 'app-update.json')
    writeUpdateState(path, { ...state, dismissedTag: 'v1.2.0' })
    expect(readUpdateState(path)).toMatchObject({ dismissedTag: 'v1.2.0' })
  })

  it('registers About and Version update UI and checks on every startup', () => {
    const client = readFileSync(join(process.cwd(), 'plugins/dsh-app-about/src/client.tsx'), 'utf8')
    const host = readFileSync(join(process.cwd(), 'plugins/dsh-app-about/src/index.ts'), 'utf8')
    const app = readFileSync(join(process.cwd(), 'src-tauri/src/app.rs'), 'utf8')
    expect(client).toContain("ctx.slots.inject('settings.section'")
    expect(client).toContain("ctx.slots.inject('sidebar.footer.action'")
    expect(client).toContain('void store.refreshAutomatic(true)')
    expect(client).toContain("document.readyState === 'complete'")
    expect(client).toContain("window.addEventListener('load', startChecks")
    expect(client).toContain('POST_STARTUP_DELAY_MS')
    expect(client).toContain('AUTOMATIC_CHECK_INTERVAL_MS')
    expect(client).toContain('24 * 60 * 60 * 1000')
    expect(client).toContain('window.setInterval(() =>')
    expect(client).not.toContain('store.refreshAutomatic(false)')
    expect(client).toContain('store.beginManualSession()')
    expect(client).toContain('store.endManualSession()')
    expect(client).toContain('void store.refreshManual()')
    expect(client).toContain('manualUpdate: null')
    expect(client).toContain('manualError: null')
    const automatic = client.slice(
      client.indexOf('async refreshAutomatic('),
      client.indexOf('dismiss(tag:'),
    )
    expect(automatic).not.toContain('manualError:')
    expect(client).toContain("this.call<void>('installUpdate', { tag })")
    expect(client).toContain('store.dismiss(release.tag)')
    expect(client).toContain('width={128} height={128}')
    expect(client).toContain('https://github.com/RyensX/dsh-app')
    expect(client).toContain('github.com/RyensX/dsh-app')
    expect(client).not.toContain('@Ryens')
    expect(client).toContain('<GitHubIcon />')
    expect(client).toContain("justifyContent: 'center'")
    expect(host).toContain("join(dirname(config), 'app-update.json')")
    expect(host).toContain("@Remote('info')")
    expect(host).toContain('async checkUpdate(force: boolean)')
    expect(host).toContain("@Remote('installUpdate')")
    expect(host).toContain('requestAppQuit(requiredEnvironment(\'DSH_APP_CONTROL_REQUEST\'))')
    expect(host).not.toContain('async checkUpdate(force = false)')
    expect(app).toContain('.env("DSH_APP_VERSION", env!("CARGO_PKG_VERSION"))')
    expect(app).toContain('.env("DSH_APP_TARGET", env!("DSH_APP_TARGET_TRIPLE"))')
    expect(app).toContain('ControlAction::Quit => quit_application(app, generation)')
  })
})
