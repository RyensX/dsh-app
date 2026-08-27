import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { installerFilename } from '../scripts/lib/installers.mjs'
import {
  assertWindowsInstallPathBudget,
  WINDOWS_INSTALL_DIR_LENGTH_BUDGET,
  WINDOWS_MAX_PATH_LENGTH,
  WINDOWS_RESOURCE_DESTINATION,
} from '../scripts/lib/windows-paths.mjs'

describe('installer publication contract', () => {
  it('keeps one cross-platform release filename format', () => {
    expect(installerFilename({
      edition: 'bundled',
      version: '0.1.0',
      platform: 'macos',
      arch: 'arm64',
    })).toBe('dsh-app-bundled-0.1.0-macos-arm64.dmg')
    expect(installerFilename({
      edition: 'lite',
      version: '0.1.0-rc.1',
      platform: 'windows',
      arch: 'x64',
    })).toBe('dsh-app-lite-0.1.0-rc.1-windows-x64.exe')
  })

  it('adds the suffix and short commit to pre-release filenames', () => {
    expect(installerFilename({
      edition: 'lite',
      version: '1.0.0',
      platform: 'windows',
      arch: 'x64',
      suffix: 'debug',
      commit: '108A43C95A21DE28DDEAF851B0103E2F443E4567',
    })).toBe('dsh-app-lite-1.0.0-windows-x64_debug_108a43c.exe')
  })

  it('requires a valid suffix and commit together', () => {
    const installer = {
      edition: 'lite',
      version: '1.0.0',
      platform: 'windows',
      arch: 'x64',
    }
    expect(() => installerFilename({ ...installer, suffix: 'debug' }))
      .toThrow('installer suffix and commit must be provided together')
    expect(() => installerFilename({ ...installer, suffix: 'debug', commit: 'not-a-commit' }))
      .toThrow('invalid installer commit')
  })

  it('publishes only from the flat installer directory', () => {
    const build = readFileSync('scripts/build-app.mjs', 'utf8')
    expect(build).toContain("resolve(root, '.build/installers')")
    expect(build).toContain('installerFilename({')
    expect(build).toContain("resolve(root, 'src-tauri', installerHooks)")
    expect(build).toContain('rmSync(bundleRoot, { recursive: true, force: true })')
    expect(build).not.toContain('archiveAndRestoreInstallers')
  })

  it('budgets the complete Windows install path after flattening pnpm', () => {
    const operation = 'getchatcompletionfieldoptionscountsv1observabilitychatcompletionfieldsfieldnameoptionscountspost.d.ts.map'
    const isolated = `${WINDOWS_RESOURCE_DESTINATION}\\dsh-runtime\\node_modules\\.pnpm\\_${'a'.repeat(32)}\\node_modules\\@mistralai\\mistralai\\esm\\models\\operations\\${operation}`
    const hoisted = `${WINDOWS_RESOURCE_DESTINATION}\\dsh-runtime\\node_modules\\@mistralai\\mistralai\\esm\\models\\operations\\${operation}`

    expect(() => assertWindowsInstallPathBudget([isolated]))
      .toThrow('Windows installer path exceeds 259 characters')
    const budget = assertWindowsInstallPathBudget([hoisted])
    expect(budget.maxPathLength).toBeLessThanOrEqual(WINDOWS_MAX_PATH_LENGTH)
    expect(budget.installRootLength).toBe(WINDOWS_INSTALL_DIR_LENGTH_BUDGET)
    expect(() => assertWindowsInstallPathBudget(['\\\\server\\share\\file.js']))
      .toThrow('invalid Windows installer relative path')
  })

  it('keeps the Bundled NSIS directory guard aligned with the build budget', () => {
    const hooks = readFileSync('src-tauri/bundled-installer-hooks.nsh', 'utf8')
    const bundled = JSON.parse(readFileSync('src-tauri/tauri.bundled.conf.json', 'utf8'))
    expect(hooks).toContain(`!define DSH_MAX_INSTALL_DIR_LENGTH ${WINDOWS_INSTALL_DIR_LENGTH_BUDGET}`)
    expect(hooks).toContain('NSIS_HOOK_PREINSTALL')
    expect(bundled.bundle.windows.nsis.installerHooks).toBe('bundled-installer-hooks.nsh')
  })
})

describe('installer GitHub workflow', () => {
  it('packages every push and uploads only standardized installers', () => {
    const source = readFileSync('.github/workflows/build-installers.yml', 'utf8')
    const workflow = parse(source) as any
    expect(Object.hasOwn(workflow.on, 'push')).toBe(true)
    expect(workflow.jobs.build.strategy.matrix.include).toHaveLength(6)
    expect(workflow.jobs.build.env.PRE_RELEASE_SUFFIX).toBe('debug')
    expect(workflow.jobs.build.env.PRE_RELEASE_COMMIT).toBe('${{ github.sha }}')
    const buildSteps = workflow.jobs.build.steps.filter(
      (step: any) => step.name?.startsWith('Build '),
    )
    expect(buildSteps).toHaveLength(3)
    for (const step of buildSteps) {
      expect(step.run).toContain('--artifact-suffix')
      expect(step.run).toContain('--artifact-commit')
    }
    const unsignedMac = buildSteps.find((step: any) => step.name === 'Build unsigned macOS installer')
    expect(unsignedMac.run).toContain('--formal false')
    const windowsTest = workflow.jobs.build.steps.find((step: any) => step.name === 'Test Windows installer')
    expect(windowsTest.if).toBe("runner.os == 'Windows'")
    expect(windowsTest.run).toContain('scripts/test-windows-installer.mjs')
    const smoke = readFileSync('scripts/test-windows-installer.mjs', 'utf8')
    expect(smoke).toContain("process.env.GITHUB_ACTIONS !== 'true'")
    expect(smoke).toContain("'scripts/test-runtime-integration.mjs'")
    expect(smoke).toContain("resolve(installRoot, 'r')")
    expect(smoke).toContain('const WINDOWS_UNINSTALL_TIMEOUT_MS = 60_000')
    expect(smoke).toContain('remaining entries (${entries.length})')
    expect(smoke.indexOf('if (failure) throw failure'))
      .toBeLessThan(smoke.indexOf('Windows installer smoke test passed'))
    const upload = workflow.jobs.build.steps.find((step: any) => step.uses === 'actions/upload-artifact@v4')
    expect(upload.with.path).toContain('.build/installers/dsh-app-')
    expect(upload.with.path).toContain('_debug_*.')
    expect(upload.with.path).not.toContain('src-tauri/target')
    expect(upload.with['include-hidden-files']).toBe(true)
  })
})
