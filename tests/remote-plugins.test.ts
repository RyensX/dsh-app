import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  readRemotePluginManifest,
  reconcileRemotePlugins,
  selectRemotePlugins,
} from '../scripts/lib/remote-plugins.mjs'

const fixtures: string[] = []

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true })
})

describe('remote plugin catalog', () => {
  it('accepts GitHub sources and filters entries by target and edition', () => {
    const root = fixture()
    const path = join(root, 'remote-plugins.json')
    writeJson(path, catalog([{
      name: 'turtle-ui',
      source: 'github:deepseek-harness/turtle-ui',
      policy: 'default',
      allowBuild: true,
      targets: ['macos', 'windows'],
      editions: ['bundled'],
    }]))

    const manifest = readRemotePluginManifest(path)
    expect(selectRemotePlugins(manifest, 'macos', 'bundled').plugins).toHaveLength(1)
    expect(selectRemotePlugins(manifest, 'macos', 'lite').plugins).toHaveLength(0)
  })

  it('accepts a bare npm package source', () => {
    const root = fixture()
    const path = join(root, 'remote-plugins.json')
    writeJson(path, catalog([{
      name: 'dshmarket',
      source: 'dshmarket',
      policy: 'default',
      targets: ['macos', 'windows'],
    }]))

    expect(readRemotePluginManifest(path).plugins[0]?.source).toBe('dshmarket')
  })

  it('rejects unsupported policies and floating npm versions', () => {
    const root = fixture()
    const policyPath = join(root, 'policy.json')
    const versionPath = join(root, 'version.json')
    writeJson(policyPath, catalog([{
      name: 'demo-plugin',
      source: 'demo-plugin@1.0.0',
      policy: 'recommended',
      targets: ['macos'],
    }]))
    writeJson(versionPath, catalog([{
      name: 'demo-plugin',
      source: 'demo-plugin@latest',
      policy: 'default',
      targets: ['macos'],
    }]))

    expect(() => readRemotePluginManifest(policyPath)).toThrow('invalid')
    expect(() => readRemotePluginManifest(versionPath)).toThrow('exact-version')
  })
})

describe('remote plugin reconciliation', () => {
  it('installs an App-managed bundle once and preserves its allowBuild authorization', () => {
    const root = fixture()
    const profileHome = join(root, 'profile')
    const profileDir = join(profileHome, 'profiles/web')
    const statePath = join(root, 'runtime/remote-plugins.state.json')
    const manifest = catalog([{
      name: 'demo-plugin',
      source: `github:example/demo-plugin#${'a'.repeat(40)}`,
      policy: 'default',
      allowBuild: true,
      targets: ['macos'],
      editions: ['bundled', 'lite'],
    }])
    let installs = 0
    const options = {
      manifest,
      target: 'macos',
      edition: 'bundled',
      profileHome,
      statePath,
      initializeProfile() {
        initializeProfile(profileDir)
      },
      installPlugin(plugin: { name: string; source: string }) {
        installs += 1
        installBundle(profileDir, plugin.name, plugin.source)
      },
    }

    expect(reconcileRemotePlugins(options)).toEqual({
      present: [],
      installed: ['demo-plugin'],
      failures: [],
    })
    expect(installs).toBe(1)
    expect(readFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'utf8'))
      .toContain('demo-plugin: true')
    expect(readJson(statePath).plugins['demo-plugin'].source)
      .toBe(`github:example/demo-plugin#${'a'.repeat(40)}`)

    expect(reconcileRemotePlugins(options)).toEqual({
      present: ['demo-plugin'],
      installed: [],
      failures: [],
    })
    expect(installs).toBe(1)
  })

  it('continues after a default plugin failure but fails a required plugin', () => {
    const root = fixture()
    const profileHome = join(root, 'profile')
    const profileDir = join(profileHome, 'profiles/web')
    const statePath = join(root, 'runtime/remote-plugins.state.json')
    const makeOptions = (policy: 'default' | 'required') => ({
      manifest: catalog([{
        name: 'broken-plugin',
        source: 'broken-plugin@1.0.0',
        policy,
        targets: ['macos'],
      }]),
      target: 'macos',
      edition: 'lite',
      profileHome,
      statePath,
      initializeProfile() {
        initializeProfile(profileDir)
      },
      installPlugin() {
        throw new Error('registry unavailable')
      },
    })

    expect(reconcileRemotePlugins(makeOptions('default')).failures).toEqual([{
      name: 'broken-plugin',
      policy: 'default',
      message: 'registry unavailable',
    }])
    expect(readJson(statePath).plugins['broken-plugin']).toEqual({
      source: 'broken-plugin@1.0.0',
      dependency: 'broken-plugin@1.0.0',
    })
    expect(() => reconcileRemotePlugins(makeOptions('required')))
      .toThrow('required remote plugins failed')
  })

  it('does not replace a user-owned dependency from another source', () => {
    const root = fixture()
    const profileHome = join(root, 'profile')
    const profileDir = join(profileHome, 'profiles/web')
    initializeProfile(profileDir)
    writeJson(join(profileDir, 'package.json'), {
      name: 'dsh-profile-web',
      private: true,
      dependencies: { 'demo-plugin': 'demo-plugin@1.0.0' },
      dsh: { profile: { bundles: [] } },
    })
    let initialized = false
    const report = reconcileRemotePlugins({
      manifest: catalog([{
        name: 'demo-plugin',
        source: 'demo-plugin@2.0.0',
        policy: 'default',
        targets: ['macos'],
      }]),
      target: 'macos',
      edition: 'bundled',
      profileHome,
      statePath: join(root, 'runtime/remote-plugins.state.json'),
      initializeProfile() {
        initialized = true
      },
      installPlugin() {
        throw new Error('must not install')
      },
    })

    expect(initialized).toBe(false)
    expect(report.failures[0]?.message).toContain('already declares')
    expect(readJson(join(profileDir, 'package.json')).dependencies['demo-plugin'])
      .toBe('demo-plugin@1.0.0')
  })
})

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-app-remote-plugins-'))
  fixtures.push(root)
  return root
}

function catalog(plugins: unknown[]): any {
  return { schemaVersion: 1, plugins }
}

function initializeProfile(profileDir: string): void {
  mkdirSync(profileDir, { recursive: true })
  if (!exists(join(profileDir, 'package.json'))) {
    writeJson(join(profileDir, 'package.json'), {
      name: 'dsh-profile-web',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [] } },
    })
  }
  if (!exists(join(profileDir, 'pnpm-workspace.yaml'))) {
    writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), [
      'packages:',
      '  - .',
      '',
      'nodeLinker: hoisted',
      'autoInstallPeers: false',
      '',
    ].join('\n'))
  }
}

function installBundle(profileDir: string, name: string, source: string): void {
  const profile = readJson(join(profileDir, 'package.json'))
  profile.dependencies[name] = source
  profile.dsh.profile.bundles.push(name)
  writeJson(join(profileDir, 'package.json'), profile)
  const packageDir = join(profileDir, 'node_modules', ...name.split('/'))
  mkdirSync(packageDir, { recursive: true })
  writeJson(join(packageDir, 'package.json'), {
    name,
    version: '1.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  })
  writeFileSync(join(packageDir, 'cordis.patch.yml'), '[]\n')
}

function exists(path: string): boolean {
  try {
    readFileSync(path)
    return true
  } catch {
    return false
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'))
}
