import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const fixtures: string[] = []
const verifier = resolve('scripts/verify-artifact.mjs')

function fixture(
  edition: 'bundled' | 'lite',
  target = 'aarch64-apple-darwin',
): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-app-artifact-'))
  fixtures.push(root)
  const platform = target.includes('windows') ? 'windows' : 'macos'
  const resourceDirectory = platform === 'windows' ? 'r' : 'resources'
  const resources = join(root, 'DSH App.app/Contents/Resources', resourceDirectory)
  const executable = join(root, 'DSH App.app/Contents/MacOS')
  mkdirSync(join(resources, 'plugin-payload/node_modules/dsh-app-runtime'), { recursive: true })
  mkdirSync(join(resources, 'plugin-payload/plugins'), { recursive: true })
  mkdirSync(join(resources, 'runtime-tools/corepack/dist'), { recursive: true })
  mkdirSync(join(resources, 'licenses'), { recursive: true })
  mkdirSync(executable, { recursive: true })
  const plugins = [{
    id: 'dsh-app-runtime',
    entry: 'node_modules/dsh-app-runtime/dist/index.mjs',
  }]
  const pluginDigest = 'c'.repeat(64)
  writeFileSync(join(resources, 'bootstrap-manifest.json'), JSON.stringify({
    schemaVersion: 1,
    app: { edition, target },
    dsh: { commit: 'a'.repeat(40), tag: 'dsh-v1.0.0', version: '1.0.0' },
    node: { version: '24.19.0', sha256: 'b'.repeat(64) },
    pluginDigest,
  }))
  writeFileSync(join(resources, 'plugin-payload/payload.json'), JSON.stringify({
    schemaVersion: 2,
    edition,
    platform,
    targetTriple: target,
    digest: pluginDigest,
    plugins,
  }))
  writeFileSync(join(resources, 'plugin-payload/plugins/index.json'), JSON.stringify({
    schemaVersion: 1,
    plugins,
  }))
  writeFileSync(join(resources, 'plugin-payload/node_modules/dsh-app-runtime/package.json'), '{}')
  writeFileSync(join(resources, 'remote-plugins.json'), JSON.stringify({
    schemaVersion: 1,
    plugins: [],
  }))
  writeFileSync(join(resources, 'dsh-app.remote-plugins.schema.json'), '{}')
  writeFileSync(join(resources, 'runtime-tools/corepack/dist/corepack.js'), 'corepack')
  writeFileSync(join(resources, 'runtime-tools/dsh-runtime-manager.mjs'), 'manager')
  writeFileSync(
    join(resources, 'licenses/DSH-App-AGPL-3.0.txt'),
    [
      'GNU AFFERO GENERAL PUBLIC LICENSE',
      '13. Remote Network Interaction',
      'END OF TERMS AND CONDITIONS',
    ].join('\n'),
  )
  writeFileSync(
    join(executable, 'dsh-app'),
    edition === 'lite'
      ? 'lite.json\nNODE_DOWNLOAD_FAILED\nNODE_CHECKSUM_MISMATCH\nlite.html'
      : 'bundled app\nindex.html',
  )
  if (edition === 'bundled') {
    const runtime = join(resources, 'dsh-runtime')
    mkdirSync(runtime, { recursive: true })
    writeFileSync(join(runtime, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }))
    writeFileSync(join(resources, 'runtime-manifest.json'), JSON.stringify({
      app: { edition: 'bundled', target },
      dsh: { commit: 'a'.repeat(40) },
      pluginDigest,
    }))
    writeFileSync(join(executable, 'node'), 'node sidecar')
  }
  return root
}

function verify(edition: 'bundled' | 'lite', path: string) {
  return spawnSync(process.execPath, [verifier, '--edition', edition, '--path', path], {
    encoding: 'utf8',
  })
}

afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('unpacked artifact verification', () => {
  it('accepts the distinct Bundled and Lite closures', () => {
    expect(verify('bundled', fixture('bundled')).status).toBe(0)
    expect(verify('lite', fixture('lite')).status).toBe(0)
  })

  it('rejects dsh files in Lite', () => {
    const root = fixture('lite')
    const runtime = join(root, 'DSH App.app/Contents/Resources/resources/dsh-runtime')
    mkdirSync(runtime, { recursive: true })
    writeFileSync(join(runtime, 'package.json'), '{}')
    const result = verify('lite', root)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('unexpectedly contains dsh')
  })

  it('rejects an artifact without the DSH App AGPL license', () => {
    const root = fixture('lite')
    const license = join(
      root,
      'DSH App.app/Contents/Resources/resources/licenses/DSH-App-AGPL-3.0.txt',
    )
    rmSync(license)
    const result = verify('lite', root)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('artifact is missing resources/licenses/DSH-App-AGPL-3.0.txt')
  })

  it('accepts an exact untagged dsh baseline commit', () => {
    const root = fixture('lite')
    const manifest = join(root, 'DSH App.app/Contents/Resources/resources/bootstrap-manifest.json')
    const bootstrap = JSON.parse(readFileSync(manifest, 'utf8'))
    bootstrap.dsh.tag = null
    writeFileSync(manifest, JSON.stringify(bootstrap))
    expect(verify('lite', root).status).toBe(0)
  })

  it('rejects a plugin payload whose runtime target uses the platform label', () => {
    const root = fixture('lite')
    const manifest = join(
      root,
      'DSH App.app/Contents/Resources/resources/plugin-payload/payload.json',
    )
    const payload = JSON.parse(readFileSync(manifest, 'utf8'))
    payload.targetTriple = 'macos'
    writeFileSync(manifest, JSON.stringify(payload))
    const result = verify('lite', root)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('target does not match')
  })

  it('rejects remote plugin code copied into the artifact', () => {
    const root = fixture('bundled')
    const resources = join(root, 'DSH App.app/Contents/Resources/resources')
    writeFileSync(join(resources, 'remote-plugins.json'), JSON.stringify({
      schemaVersion: 1,
      plugins: [{
        name: 'dshmarket',
        source: 'dshmarket',
        policy: 'default',
        targets: ['macos'],
      }],
    }))
    mkdirSync(join(resources, 'dsh-runtime/node_modules/dshmarket'), { recursive: true })
    writeFileSync(join(resources, 'dsh-runtime/node_modules/dshmarket/package.json'), '{}')

    const result = verify('bundled', root)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('remote plugin source leaked into artifact')
  })

  it('rejects isolated virtual-store files in a Bundled artifact', () => {
    const root = fixture('bundled')
    const leaked = join(
      root,
      'DSH App.app/Contents/Resources/resources/dsh-runtime/node_modules/.pnpm/demo/node_modules/demo',
    )
    mkdirSync(leaked, { recursive: true })
    writeFileSync(join(leaked, 'index.js'), 'export {}\n')

    const result = verify('bundled', root)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('isolated pnpm virtual store')
  })

  it('rejects upstream sources in a hoisted Bundled artifact', () => {
    const root = fixture('bundled')
    const leaked = join(
      root,
      'DSH App.app/Contents/Resources/resources/dsh-runtime/node_modules/@deepseek-ai/example/src',
    )
    mkdirSync(leaked, { recursive: true })
    writeFileSync(join(leaked, 'index.ts'), 'export {}\n')

    const result = verify('bundled', root)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('dsh source leaked into artifact')
  })

  it('rejects Windows artifacts that exceed the default install path budget', () => {
    const root = fixture('bundled', 'x86_64-pc-windows-msvc')
    const directory = join(
      root,
      'DSH App.app/Contents/Resources/r/dsh-runtime/node_modules/demo',
    )
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, `${'x'.repeat(190)}.js`), 'export {}\n')

    const result = verify('bundled', root)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Windows installer path exceeds 259 characters')
  })

  it('requires the short resource container in Windows artifacts', () => {
    const root = fixture('lite', 'x86_64-pc-windows-msvc')
    const contents = join(root, 'DSH App.app/Contents/Resources')
    renameSync(join(contents, 'r'), join(contents, 'resources'))

    const result = verify('lite', root)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('artifact resource directory mismatch')
  })
})
