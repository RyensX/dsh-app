import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildPluginPayload,
  buildPlugins,
  discoverPlugins,
  selectPlugins,
} from '../scripts/lib/plugins.mjs'

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: 'demo-plugin',
    enabled: true,
    source: 'src/index.ts',
    entry: 'dist/index.mjs',
    targets: ['macos'],
    config: { greeting: 'hello' },
    ...overrides,
  }
}

function fixture() {
  const root = join(process.env.TMPDIR ?? '/tmp', `dsh-app-plugin-test-${process.pid}-${Math.random()}`)
  const plugin = join(root, 'plugins/demo')
  mkdirSync(join(plugin, 'src'), { recursive: true })
  writeFileSync(join(plugin, 'src/index.ts'), 'export function apply() { return "loaded" }\n')
  writeFileSync(join(plugin, 'dsh-app.plugin.json'), JSON.stringify(manifest()))
  return { root, plugins: join(root, 'plugins'), plugin }
}

function runtime(root: string) {
  const path = join(root, 'runtime')
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh',
    dependencies: {},
  }))
  return path
}

describe('plugin contract', () => {
  it('filters enabled plugins by build target', () => {
    const { plugins } = fixture()
    const discovered = discoverPlugins(plugins)
    expect(selectPlugins(discovered, 'macos')).toHaveLength(1)
    expect(selectPlugins(discovered, 'windows')).toHaveLength(0)
  })

  it('filters plugins by edition when the manifest declares editions', () => {
    const { plugins, plugin } = fixture()
    writeFileSync(
      join(plugin, 'dsh-app.plugin.json'),
      JSON.stringify(manifest({ editions: ['lite'] })),
    )
    const discovered = discoverPlugins(plugins)
    expect(selectPlugins(discovered, 'macos', 'bundled')).toHaveLength(0)
    expect(selectPlugins(discovered, 'macos', 'lite')).toHaveLength(1)
  })

  it('rejects paths that escape the plugin directory', () => {
    const { plugins, plugin } = fixture()
    writeFileSync(
      join(plugin, 'dsh-app.plugin.json'),
      JSON.stringify(manifest({ source: '../outside.ts' })),
    )
    expect(() => discoverPlugins(plugins)).toThrow(/contained relative path/u)
  })

  it('builds selected plugins as ESM and writes a deterministic index', async () => {
    const { root, plugins } = fixture()
    const runtimeRoot = runtime(root)
    const index = await buildPlugins({ pluginsRoot: plugins, runtimeRoot, target: 'macos' })
    expect(index).toEqual([
      {
        id: 'demo-plugin',
        entry: 'node_modules/demo-plugin/dist/index.mjs',
        config: { greeting: 'hello' },
        manifest: 'node_modules/demo-plugin/dsh-app.plugin.json',
      },
    ])
    expect(readFileSync(join(runtimeRoot, 'node_modules/demo-plugin/dist/index.mjs'), 'utf8')).toContain('function apply')
    expect(JSON.parse(readFileSync(join(runtimeRoot, 'plugins/index.json'), 'utf8')).plugins).toEqual(index)
    expect(JSON.parse(readFileSync(join(runtimeRoot, 'package.json'), 'utf8')).dependencies['demo-plugin']).toBe('0.0.0')
  })

  it('builds a dsh-discoverable browser half with the lazy-CJS handoff', async () => {
    const { root, plugins, plugin } = fixture()
    writeFileSync(join(plugin, 'src/client.ts'), 'export function apply() { return "client-loaded" }\n')
    writeFileSync(
      join(plugin, 'dsh-app.plugin.json'),
      JSON.stringify(manifest({
        client: {
          source: 'src/client.ts',
          entry: 'dist/client.js',
          immediately: true,
        },
      })),
    )

    const runtimeRoot = runtime(root)
    await buildPlugins({ pluginsRoot: plugins, runtimeRoot, target: 'macos' })
    const packageRoot = join(runtimeRoot, 'node_modules/demo-plugin')
    const packageManifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
    expect(packageManifest.exports['./client']).toBe('./dist/client.js')
    expect(packageManifest.exports['./package.json']).toBe('./package.json')
    expect(packageManifest.dsh.client).toEqual({ platform: 'web', immediately: true })
    const bundle = readFileSync(join(packageRoot, 'dist/client.js'), 'utf8')
    expect(bundle).toContain('window.__ModuleLoader__.load({ id: "demo-plugin"')
    expect(bundle).toContain('return module.exports; } });')
  })

  it('inlines PNG assets imported by a browser half', async () => {
    const { root, plugins, plugin } = fixture()
    writeFileSync(join(plugin, 'src/icon.png'), 'small-plugin-icon')
    writeFileSync(
      join(plugin, 'src/client.ts'),
      "import icon from './icon.png'; export function apply() { return icon }\n",
    )
    writeFileSync(
      join(plugin, 'dsh-app.plugin.json'),
      JSON.stringify(manifest({
        client: {
          source: 'src/client.ts',
          entry: 'dist/client.js',
          immediately: true,
        },
      })),
    )

    const runtimeRoot = runtime(root)
    await buildPlugins({ pluginsRoot: plugins, runtimeRoot, target: 'macos' })
    const bundle = readFileSync(join(runtimeRoot, 'node_modules/demo-plugin/dist/client.js'), 'utf8')
    expect(bundle).toContain('data:image/png')
  })

  it('records plugin selection platform separately from the runtime target triple', async () => {
    const { root, plugins } = fixture()
    const payloadRoot = join(root, 'payload')
    await buildPluginPayload({
      pluginsRoot: plugins,
      payloadRoot,
      platform: 'macos',
      targetTriple: 'aarch64-apple-darwin',
      edition: 'lite',
    })
    const payload = JSON.parse(readFileSync(join(payloadRoot, 'payload.json'), 'utf8'))
    expect(payload).toMatchObject({
      schemaVersion: 2,
      edition: 'lite',
      platform: 'macos',
      targetTriple: 'aarch64-apple-darwin',
    })
    expect(payload.plugins).toHaveLength(1)
    expect(payload.digest).toMatch(/^[a-f0-9]{64}$/u)
  })
})
