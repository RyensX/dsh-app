import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  completeWorkspaceRuntimeClosure,
  enableInjectedWorkspacePackages,
} from '../scripts/lib/workspace-runtime.mjs'

function fixture() {
  const root = join(process.env.TMPDIR ?? '/tmp', `dsh-app-workspace-test-${process.pid}-${Math.random()}`)
  mkdirSync(join(root, 'apps/cli'), { recursive: true })
  mkdirSync(join(root, 'packages/core/feature'), { recursive: true })
  mkdirSync(join(root, 'packages/core/leaf'), { recursive: true })
  mkdirSync(join(root, 'packages/subprocess/subprocess-local'), { recursive: true })
  mkdirSync(join(root, 'vendor/framework'), { recursive: true })
  writeFileSync(join(root, 'pnpm-workspace.yaml'), [
    'packages:',
    '  - packages/*/*',
    '  - apps/*',
    '  - vendor/*',
    'overrides:',
    "  '@deepseek-ai/framework': link:vendor/framework",
    'allowBuilds:',
    '  esbuild: true',
    '',
  ].join('\n'))
  writeFileSync(join(root, 'apps/cli/package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh',
    dependencies: { '@deepseek-ai/feature': 'workspace:^', external: '^1.0.0' },
    devDependencies: { development: '^1.0.0' },
  }))
  writeFileSync(join(root, 'packages/core/feature/package.json'), JSON.stringify({
    name: '@deepseek-ai/feature',
    dependencies: { '@deepseek-ai/leaf': 'workspace:^' },
    peerDependencies: {
      '@deepseek-ai/framework': 'workspace:^',
      '@deepseek-ai/optional': 'workspace:^',
    },
    peerDependenciesMeta: { '@deepseek-ai/optional': { optional: true } },
  }))
  writeFileSync(join(root, 'packages/core/leaf/package.json'), JSON.stringify({
    name: '@deepseek-ai/leaf',
  }))
  writeFileSync(join(root, 'vendor/framework/package.json'), JSON.stringify({
    name: '@deepseek-ai/framework',
  }))
  writeFileSync(join(root, 'packages/subprocess/subprocess-local/package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-subprocess-local',
  }))
  writeFileSync(join(root, 'pnpm-lock.yaml'), [
    "lockfileVersion: '9.0'",
    'settings:',
    '  autoInstallPeers: true',
    'importers:',
    '  apps/cli:',
    '    dependencies:',
    "      '@deepseek-ai/feature':",
    '        specifier: workspace:^',
    '        version: link:../../packages/core/feature',
    '      external:',
    '        specifier: ^1.0.0',
    '        version: 1.0.0',
    '    devDependencies:',
    '      development:',
    '        specifier: ^1.0.0',
    '        version: 1.0.0',
    'packages:',
    '  external@1.0.0:',
    '    resolution:',
    '      integrity: sha512-fixed',
    '',
  ].join('\n'))
  return root
}

describe('dsh workspace runtime closure', () => {
  it('promotes required peers without changing external lock resolution', () => {
    const root = fixture()
    const injection = enableInjectedWorkspacePackages(root)
    const result = completeWorkspaceRuntimeClosure(root)
    const manifest = JSON.parse(readFileSync(join(root, 'apps/cli/package.json'), 'utf8'))
    const workspace = parse(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'))
    const lockfile = parse(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'))

    expect(result.addedPeers).toEqual(['@deepseek-ai/framework'])
    expect(result.reachablePackages).toBe(3)
    expect(result.workspacePackageNames).toEqual([
      '@deepseek-ai/feature',
      '@deepseek-ai/framework',
      '@deepseek-ai/leaf',
    ])
    expect(manifest.dependencies['@deepseek-ai/framework']).toBe('workspace:^')
    expect(manifest.dependencies['@deepseek-ai/optional']).toBeUndefined()
    expect(manifest.devDependencies).toBeUndefined()
    expect(lockfile.importers['apps/cli'].devDependencies).toBeUndefined()
    expect(lockfile.importers['apps/cli'].dependencies['@deepseek-ai/framework']).toEqual({
      specifier: 'link:../../vendor/framework',
      version: 'link:../../vendor/framework',
    })
    expect(lockfile.packages).toEqual({
      'external@1.0.0': { resolution: { integrity: 'sha512-fixed' } },
    })
    expect(workspace.injectWorkspacePackages).toBe(true)
    expect(workspace.syncInjectedDepsAfterScripts).toEqual(['build'])
    expect(workspace.allowBuilds.esbuild).toBe(true)
    expect(workspace.allowBuilds[injection.subprocessLocator]).toBe(true)
    expect(lockfile.settings.injectWorkspacePackages).toBe(true)
  })
})
