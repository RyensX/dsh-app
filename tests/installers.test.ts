import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { installerFilename } from '../scripts/lib/installers.mjs'

describe('installer publication contract', () => {
  it('uses one cross-platform filename format', () => {
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

  it('publishes only from the flat installer directory', () => {
    const build = readFileSync('scripts/build-app.mjs', 'utf8')
    expect(build).toContain("resolve(root, '.build/installers')")
    expect(build).toContain('installerFilename({')
    expect(build).toContain('rmSync(bundleRoot, { recursive: true, force: true })')
    expect(build).not.toContain('archiveAndRestoreInstallers')
  })
})

describe('installer GitHub workflow', () => {
  it('packages every push and uploads only standardized installers', () => {
    const source = readFileSync('.github/workflows/build-installers.yml', 'utf8')
    const workflow = parse(source) as any
    expect(Object.hasOwn(workflow.on, 'push')).toBe(true)
    expect(workflow.jobs.build.strategy.matrix.include).toHaveLength(6)
    const unsignedMac = workflow.jobs.build.steps.find(
      (step: any) => step.name === 'Build unsigned macOS installer',
    )
    expect(unsignedMac.run).toContain('--formal false')
    const upload = workflow.jobs.build.steps.find((step: any) => step.uses === 'actions/upload-artifact@v4')
    expect(upload.with.path).toContain('.build/installers/dsh-app-')
    expect(upload.with.path).not.toContain('src-tauri/target')
    expect(upload.with['include-hidden-files']).toBe(true)
  })
})
