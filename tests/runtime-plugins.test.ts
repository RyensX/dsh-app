import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { refreshRuntimePlugins } from '../scripts/lib/runtime-plugins.mjs'

const fixtures: string[] = []

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true })
})

describe('managed runtime App plugin refresh', () => {
  it('updates only App plugins while preserving a compiled runtime at any dsh commit', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-app-plugin-refresh-'))
    fixtures.push(root)
    const installRoot = join(root, 'install')
    const runtimeRoot = join(installRoot, 'dsh-runtime')
    const payloadRoot = join(root, 'payload')
    mkdirSync(join(runtimeRoot, 'plugins'), { recursive: true })
    mkdirSync(join(runtimeRoot, 'node_modules/app-plugin'), { recursive: true })
    mkdirSync(join(payloadRoot, 'plugins'), { recursive: true })
    mkdirSync(join(payloadRoot, 'node_modules/app-plugin/dist'), { recursive: true })

    writeJson(join(installRoot, 'runtime-manifest.json'), {
      schemaVersion: 1,
      app: { version: '0.1.0', edition: 'managed', target: 'aarch64-apple-darwin' },
      dsh: {
        // 与 App 基线不同，证明本地插件刷新不拿 Commit 判断运行时是否可复用。
        commit: 'b'.repeat(40),
        tag: 'dsh-v9.0.0',
        nodeEngine: '>=24',
        entry: 'dsh-runtime/lib/bin.js',
      },
      native: { platform: 'darwin', arch: 'arm64', nodeAbi: '137' },
      bundledNode: null,
      plugins: [{ id: 'app-plugin', entry: 'node_modules/app-plugin/dist/index.mjs' }],
      pluginDigest: 'a'.repeat(64),
    })
    writeJson(join(runtimeRoot, 'package.json'), {
      name: '@deepseek-ai/dsh',
      dependencies: { stable: '1.0.0', 'app-plugin': '0.0.0' },
    })
    writeJson(join(runtimeRoot, 'plugins/index.json'), {
      schemaVersion: 1,
      plugins: [{
        id: 'app-plugin',
        entry: 'node_modules/app-plugin/dist/index.mjs',
        config: {},
        manifest: 'node_modules/app-plugin/dsh-app.plugin.json',
      }],
    })
    writeFileSync(join(runtimeRoot, 'node_modules/app-plugin/old.txt'), 'old\n')

    const plugins = [{ id: 'app-plugin', entry: 'node_modules/app-plugin/dist/index.mjs' }]
    writeJson(join(payloadRoot, 'payload.json'), {
      schemaVersion: 2,
      edition: 'lite',
      platform: 'macos',
      targetTriple: 'aarch64-apple-darwin',
      digest: 'b'.repeat(64),
      plugins,
    })
    writeJson(join(payloadRoot, 'plugins/index.json'), {
      schemaVersion: 1,
      plugins: [{
        ...plugins[0],
        config: {},
        manifest: 'node_modules/app-plugin/dsh-app.plugin.json',
      }],
    })
    writeJson(join(payloadRoot, 'node_modules/app-plugin/package.json'), {
      name: 'app-plugin',
      version: '0.0.0',
    })
    writeFileSync(join(payloadRoot, 'node_modules/app-plugin/dist/index.mjs'), 'export default true\n')

    const bootstrap = {
      schemaVersion: 1,
      app: { version: '0.2.0', edition: 'lite', target: 'aarch64-apple-darwin' },
      dsh: { commit: 'a'.repeat(40), commitTime: '2026-08-01T00:00:00Z' },
      pluginDigest: 'b'.repeat(64),
    }
    expect(refreshRuntimePlugins({ installRoot, payloadRoot, bootstrap })).toEqual({
      pluginDigest: 'b'.repeat(64),
      plugins,
    })

    const manifest = readJson(join(installRoot, 'runtime-manifest.json'))
    const runtimePackage = readJson(join(runtimeRoot, 'package.json'))
    expect(manifest.dsh.commit).toBe('b'.repeat(40))
    expect(manifest.dsh.commitTime).toBeUndefined()
    expect(manifest.app.version).toBe('0.2.0')
    expect(manifest.pluginDigest).toBe('b'.repeat(64))
    expect(manifest.plugins).toEqual(plugins)
    expect(runtimePackage.dependencies).toEqual({ stable: '1.0.0', 'app-plugin': '0.0.0' })
    expect(existsSync(join(runtimeRoot, 'node_modules/app-plugin/old.txt'))).toBe(false)
    expect(readFileSync(join(runtimeRoot, 'node_modules/app-plugin/dist/index.mjs'), 'utf8'))
      .toBe('export default true\n')
  })

  it('rejects a platform label used in place of the target triple before modifying the runtime', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-app-plugin-identity-'))
    fixtures.push(root)
    const installRoot = join(root, 'install')
    const runtimeRoot = join(installRoot, 'dsh-runtime')
    const payloadRoot = join(root, 'payload')
    mkdirSync(join(runtimeRoot, 'plugins'), { recursive: true })
    mkdirSync(join(payloadRoot, 'plugins'), { recursive: true })
    writeJson(join(installRoot, 'runtime-manifest.json'), {
      schemaVersion: 1,
      app: { version: '0.1.0', edition: 'managed', target: 'aarch64-apple-darwin' },
      dsh: { commit: 'a'.repeat(40), entry: 'dsh-runtime/lib/bin.js' },
      plugins: [],
      pluginDigest: 'a'.repeat(64),
    })
    writeJson(join(runtimeRoot, 'package.json'), { name: '@deepseek-ai/dsh' })
    writeFileSync(join(runtimeRoot, 'preserved.txt'), 'compiled runtime\n')
    writeJson(join(payloadRoot, 'payload.json'), {
      schemaVersion: 2,
      edition: 'lite',
      platform: 'macos',
      // 复现旧生成器把 platform 误写进运行时身份字段的情况。
      targetTriple: 'macos',
      digest: 'b'.repeat(64),
      plugins: [],
    })
    writeJson(join(payloadRoot, 'plugins/index.json'), { schemaVersion: 1, plugins: [] })
    const bootstrap = {
      schemaVersion: 1,
      app: { version: '0.2.0', edition: 'lite', target: 'aarch64-apple-darwin' },
      pluginDigest: 'b'.repeat(64),
    }

    expect(() => refreshRuntimePlugins({ installRoot, payloadRoot, bootstrap }))
      .toThrow('target does not match')
    expect(readFileSync(join(runtimeRoot, 'preserved.txt'), 'utf8')).toBe('compiled runtime\n')
    expect(readJson(join(installRoot, 'runtime-manifest.json')).pluginDigest).toBe('a'.repeat(64))
  })
})

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>
}
