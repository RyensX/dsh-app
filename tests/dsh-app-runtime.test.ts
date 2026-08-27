import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { discoverPlugins } from '../scripts/lib/plugins.mjs'

describe('dsh-app-runtime plugin', () => {
  it('is packaged for both desktop editions with a settings client', () => {
    const plugin = discoverPlugins(join(process.cwd(), 'plugins'))
      .find(candidate => candidate.manifest.id === 'dsh-app-runtime')
    expect(plugin?.manifest).toMatchObject({
      enabled: true,
      targets: ['macos', 'windows'],
      editions: ['bundled', 'lite'],
      client: { immediately: true },
    })
    expect(plugin?.manifest.client?.inject).toContain('@deepseek-ai/dsh-client-ui-conversation')
  })

  it('shows the Dsh runtime commits, clears stale checks on entry, and gates restore', () => {
    const client = readFileSync(join(process.cwd(), 'plugins/dsh-app-runtime/src/client.tsx'), 'utf8')
    const locales = readFileSync(join(process.cwd(), 'plugins/dsh-app-runtime/src/locales.ts'), 'utf8')
    const host = readFileSync(join(process.cwd(), 'plugins/dsh-app-runtime/src/index.ts'), 'utf8')
    expect(locales).toContain('更新非内置版本的dsh后可能出现兼容性或启动问题')
    expect(locales).toContain('管理App使用的dsh运行时')
    expect(locales).toContain("title: 'App Runtime'")
    expect(locales).toContain("title: 'App运行时'")
    expect(client).toContain('ctx.locale.register(NS, { zh, en })')
    expect(client).toContain('locale: NS')
    expect(client).toContain('Button, IconChevronDownOutline14, IconLoadingOutline16, Menu, StateDot')
    expect(client).not.toContain('<Pill>')
    expect(client).not.toContain('<dt>版本</dt>')
    const enterEffect = client.slice(
      client.indexOf('React.useEffect(() =>'),
      client.indexOf('const timer = window.setInterval'),
    )
    expect(enterEffect).toContain('store.resetCheck()')
    expect(enterEffect).not.toContain('store.checkUpdate()')
    expect(client).toContain('<CommitLink repository={info.repository} commit={info.commit} title={t(\'viewCommit\')} />')
    expect(client).toContain('formatCommitTime(info.commitTime, locale, t)')
    expect(client).toContain("title={t('noUpdate')}")
    expect(client).toContain('canRestoreBaseline')
    expect(client).toContain("operation?.state !== 'ready'")
    expect(host).toContain("requiredEnvironment('DSH_APP_DSH_COMMIT') !== requiredEnvironment('DSH_APP_BASELINE_COMMIT')")
    expect(locales).toContain("restoreBuiltIn: '还原内置版本'")
    expect(locales).toContain("restoreBaseline: '还原 App 基线版本'")
    expect(locales).toContain("restartNow: '立即重启'")
    expect(client).toContain('data-dsh-app-runtime-restore="true"')
    expect(client).toContain('variant="outline"\n                size="sm"\n                data-dsh-app-runtime-restore="true"')
    expect(client).not.toContain('[data-dsh-app-runtime-restore] {')
    expect(client).toContain("justifyContent: 'space-between'")
    expect(client).toContain('data-dsh-app-runtime-channel="true"')
    expect(client).toContain('<ChannelSelector')
    expect(client).toContain('<Menu')
    expect(client).toContain('<IconChevronDownOutline14 style={styles.channelChevron} />')
    expect(client).toContain("height: 36")
    expect(client).toContain("borderRadius: 18")
    expect(client).toContain("background: 'var(--dsw-alias-bg-module-platform)'")
    expect(client).not.toContain('<select')
    expect(client).not.toContain('<option')
    expect(client).not.toContain('backgroundImage:')
    expect(locales).toContain("channel: '通道'")
    expect(locales).toContain("channelStable: '稳定'")
    expect(locales).toContain("channelLatest: '最新'")
  })

  it('uses Git for source checkout and commit-based update discovery', () => {
    const manager = readFileSync(join(process.cwd(), 'scripts/runtime-manager-entry.mjs'), 'utf8')
    const prepare = readFileSync(join(process.cwd(), 'scripts/prepare-resources.mjs'), 'utf8')
    expect(prepare).toContain('readDshSubmoduleRepository(root)')
    expect(manager).toContain('syncDshSource')
    expect(manager).toContain("destination: resolve(dshRoot, 'source')")
    expect(manager).toContain('createDshBuildWorktree')
    expect(manager).toContain("destination: resolve(temporary, 'source')")
    expect(manager).toContain('enableInjectedWorkspacePackages(buildSourceRoot)')
    expect(manager).not.toContain('enableInjectedWorkspacePackages(persistentSourceRoot)')
    expect(manager).toContain('materializeProductionRuntime(deployedRuntimeRoot, runtimeRoot)')
    expect(prepare).toContain("'--config.node-linker=hoisted'")
    expect(prepare).toContain("'--config.hoisting-limits=none'")
    expect(prepare).toContain("nodeModulesLayout: 'hoisted'")
    expect(prepare).not.toContain("'--config.virtual-store-dir-max-length=20'")
    expect(manager).toContain("'--config.shamefully-hoist=true'")
    expect(manager).toContain("'--config.virtual-store-dir-max-length=50'")
    expect(manager).toContain("nodeModulesLayout: 'isolated'")
    expect(manager).toContain('builderVersion: BUILDER_VERSION')
    expect(manager).toContain("else if (command === 'prepare-restore-profile')")
    expect(manager).toContain("requiredArg(args, 'current-commit')")
    expect(manager).toContain("args.get('current-tag') ?? null")
    expect(manager).toContain("args.get('channel') ?? 'stable'")
    expect(manager).toContain('readDshCommitTime(persistentSourceRoot, commit)')
    expect(manager).toContain("pnpm_config_network_concurrency: '16'")
    expect(manager).toContain("pnpm_config_fetch_timeout: '300000'")
    expect(manager).toContain("'enable',")
    expect(manager).toContain("'--install-directory', pnpmHome")
    expect(manager).toContain('writeNpmCompatibilityShims')
    expect(manager).toContain("'check-update'")
    expect(manager).not.toContain('api.github.com')
    expect(manager).not.toContain('codeload.github.com')
  })

  it('persists stable/latest channels and integrates the command-line action', () => {
    const client = readFileSync(join(process.cwd(), 'plugins/dsh-app-runtime/src/client.tsx'), 'utf8')
    const host = readFileSync(join(process.cwd(), 'plugins/dsh-app-runtime/src/index.ts'), 'utf8')
    const git = readFileSync(join(process.cwd(), 'scripts/lib/dsh-git.mjs'), 'utf8')
    const manager = readFileSync(join(process.cwd(), 'scripts/runtime-manager-entry.mjs'), 'utf8')
    const app = readFileSync(join(process.cwd(), 'src-tauri/src/app.rs'), 'utf8')
    expect(host).toContain("@Remote('setChannel')")
    expect(host).toContain("@Remote('openCommandLine')")
    expect(host).toContain("'--channel', readRuntimeChannel(configPath())")
    expect(host).toContain('writeRuntimeChannel(configPath(), channel)')
    expect(git).toContain("git(['ls-remote', '--symref', repository, 'HEAD'])")
    expect(git).toContain("'ls-remote', '--tags', repository, 'refs/tags/dsh-v*'")
    expect(app).toContain('.env("DSH_APP_CONFIG", &dirs.config)')
    expect(client).toContain("this.call<void>('openCommandLine')")
    expect(client).toContain("t('openCommandLine')")
    expect(client).toContain('onClick={() => { void store.openCommandLine() }}')
    expect(client).not.toContain('if (opened) close()')
    expect(client).toContain('formatCommitTime(update.latestCommitTime, locale, t)')
    expect(manager).toContain('readRemoteDshCommitTime')
  })

  it('disables the upstream browser handoff for the desktop-owned WebView', () => {
    const app = readFileSync(join(process.cwd(), 'src-tauri/src/app.rs'), 'utf8')
    expect(app).toContain('.arg("--no-open")')
  })

  it('restarts the complete desktop process after a controlled runtime switch', () => {
    const app = readFileSync(join(process.cwd(), 'src-tauri/src/app.rs'), 'utf8')
    const client = readFileSync(join(process.cwd(), 'plugins/dsh-app-runtime/src/client.tsx'), 'utf8')
    const host = readFileSync(join(process.cwd(), 'plugins/dsh-app-runtime/src/index.ts'), 'utf8')
    const restart = app.slice(
      app.indexOf('fn restart_application('),
      app.indexOf('fn terminate_generation('),
    )
    const watcher = app.slice(
      app.indexOf('fn spawn_exit_watcher('),
      app.indexOf('struct ControlRequest'),
    )
    expect(watcher.indexOf('consume_control_request(&control_request)'))
      .toBeLessThan(watcher.indexOf('.try_wait()'))
    expect(app).toContain('ControlAction::Restart => restart_application(app, generation)')
    expect(restart).toContain('graceful_stop(&mut child, STOP_GRACE)')
    expect(restart).toContain('tauri_plugin_single_instance::destroy(app)')
    expect(restart).toContain('app.request_restart()')
    expect(restart).not.toContain('navigate_to_bootstrap')
    expect(restart).not.toContain('launch_worker')
    expect(host).toContain('notBeforeMs: Date.now() + RESTART_ACK_DELAY_MS')
    expect(host).not.toContain("this.ctx.get('appExit')")
    expect(app).toContain('consume_control_request_at(path, now_ms)')

    const refreshMethod = client.slice(client.indexOf('async refresh()'), client.indexOf('async checkUpdate()'))
    const restartMethod = client.slice(client.indexOf('async restart()'), client.indexOf('async openCommandLine()'))
    expect(refreshMethod).toContain('if (this.snapshot.restarting) return')
    expect(restartMethod).toContain('restarting: true')
    expect(restartMethod).toContain('restarting: false')
    expect(client).toContain('disabled={state.restarting}')
  })

  it('restores Lite to the App baseline and can prepare a localized update-summary prompt', () => {
    const client = readFileSync(join(process.cwd(), 'plugins/dsh-app-runtime/src/client.tsx'), 'utf8')
    const host = readFileSync(join(process.cwd(), 'plugins/dsh-app-runtime/src/index.ts'), 'utf8')
    const locales = readFileSync(join(process.cwd(), 'plugins/dsh-app-runtime/src/locales.ts'), 'utf8')
    const manager = readFileSync(join(process.cwd(), 'scripts/runtime-manager-entry.mjs'), 'utf8')
    const native = readFileSync(join(process.cwd(), 'src-tauri/src/runtime_manager.rs'), 'utf8')
    expect(host).toContain("activation: 'restore'")
    expect(host).toContain("requiredEnvironment('DSH_APP_BASELINE_COMMIT')")
    expect(manager).toContain("action: 'restoreManaged'")
    expect(native).toContain('PendingAction::RestoreManaged')
    expect(client).toContain("ctx.conversation.input.for(scope).setDraft(prompt)")
    expect(client).toContain("t('summarizeUpdate')")
    expect(client).toContain('compareUrl:')
    expect(locales).toContain("summarizeUpdate: '总结更新内容'")
    expect(locales).toContain("summarizeUpdate: 'Summarize update'")
    expect(locales).toContain('当前运行时 Commit {currentCommit} 与最新 Commit {latestCommit}')
  })

  it('locks Settings while updating and turns the install action into restart', () => {
    const client = readFileSync(join(process.cwd(), 'plugins/dsh-app-runtime/src/client.tsx'), 'utf8')
    const host = readFileSync(join(process.cwd(), 'plugins/dsh-app-runtime/src/index.ts'), 'utf8')
    const locales = readFileSync(join(process.cwd(), 'plugins/dsh-app-runtime/src/locales.ts'), 'utf8')
    const updateMethod = client.slice(client.indexOf('async update()'), client.indexOf('async restore()'))
    expect(updateMethod).not.toContain('window.confirm')
    expect(updateMethod).toContain("action: 'update'")
    expect(updateMethod).toContain("state: 'building'")
    expect(client).toContain('useSettingsLock(sectionRef, busy)')
    expect(client).toContain("button.disabled = true")
    expect(client).not.toContain('disabled={busy}')
    expect(client).toContain("event.stopImmediatePropagation()")
    expect(client).toContain('<IconLoadingOutline16 size={16} />')
    expect(client).toContain("operation?.state === 'ready'")
    expect(host).toContain("action: request.action")
    expect(client).not.toContain("t('restartLaterHint')")
    expect(locales).not.toContain('即使不立即重启')
    expect(locales).not.toContain('If you do not restart now')
    const actions = client.slice(
      client.indexOf('<div style={styles.actions}>'),
      client.indexOf('</div>\n    </section>'),
    )
    expect(actions.indexOf('store.openCommandLine()'))
      .toBeLessThan(actions.indexOf('store.update()'))
    expect(actions.indexOf('store.openCommandLine()'))
      .toBeLessThan(actions.indexOf('store.restart()'))
  })

  it('reuses a compatible compiled runtime without comparing its dsh commit', () => {
    const resolver = readFileSync(join(process.cwd(), 'src-tauri/src/runtime_manager.rs'), 'utf8')
    const managed = resolver.slice(
      resolver.indexOf('fn load_managed('),
      resolver.indexOf('fn validate_bundled('),
    )
    const pluginRefresh = readFileSync(
      join(process.cwd(), 'scripts/lib/runtime-plugins.mjs'),
      'utf8',
    )
    expect(managed).not.toContain('bootstrap.dsh.commit')
    expect(managed).toContain('layout.manifest.builder_version == Some(MANAGED_RUNTIME_BUILDER_VERSION)')
    expect(resolver).toContain('const MANAGED_RUNTIME_BUILDER_VERSION: u32 = 2;')
    expect(managed).toContain('managed_runtime_compatible')
    expect(managed).toContain('refresh_managed_plugins')
    expect(pluginRefresh).not.toContain('syncDshSource')
    expect(pluginRefresh).not.toContain('corepackPnpm')
  })

  it('keeps restore pending across launch failure and localizes the ready state', () => {
    const app = readFileSync(join(process.cwd(), 'src-tauri/src/app.rs'), 'utf8')
    const resolver = readFileSync(join(process.cwd(), 'src-tauri/src/runtime_manager.rs'), 'utf8')
    const client = readFileSync(join(process.cwd(), 'plugins/dsh-app-runtime/src/client.tsx'), 'utf8')
    const locales = readFileSync(join(process.cwd(), 'plugins/dsh-app-runtime/src/locales.ts'), 'utf8')
    expect(app).toContain('runtime_manager::rollback_failed_pending(&dirs)')
    expect(resolver).toContain('Ok(Some(PendingAction::ActivateManaged { .. })) | Err(_)')
    expect(resolver).toContain('PendingAction::RestoreManaged { .. } | PendingAction::RestoreBundled { .. }')
    expect(resolver).toContain('prepare_restore_profile(app, dirs, node, &layout)?')
    expect(locales).toContain("stageRestoreReady: '已还原运行时，重启后生效。'")
    expect(locales).toContain("stageRestoreReady: 'The runtime has been restored and will take effect after restart.'")
  })
})
