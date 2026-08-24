import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const fixtures: string[] = []

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true })
})

describe('runtime manager restore activation', () => {
  it('publishes a restoreManaged action when the compiled baseline already exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-app-restore-manager-'))
    fixtures.push(root)
    const userRuntime = join(root, 'runtime')
    const bootstrapPath = join(root, 'bootstrap.json')
    const commit = 'a'.repeat(40)
    const tag = 'dsh-v1.0.0'
    const target = 'fixture-target'
    const pluginDigest = 'b'.repeat(64)
    const probe = {
      abi: String(process.versions.modules ?? ''),
      platform: process.platform,
      arch: process.arch,
    }
    const runtimeId = createHash('sha256').update(JSON.stringify({
      builder: 2,
      commit,
      target,
      abi: probe.abi,
      pluginDigest,
    })).digest('hex').slice(0, 32)
    const installRoot = join(userRuntime, 'dsh/installs', runtimeId)
    mkdirSync(join(installRoot, 'dsh-runtime/lib'), { recursive: true })
    writeFileSync(join(installRoot, 'dsh-runtime/lib/bin.js'), 'export {}\n')
    writeJson(bootstrapPath, {
      schemaVersion: 1,
      app: { version: '0.1.0', edition: 'lite', target },
      dsh: {
        repository: 'https://github.com/deepseek-ai/deepseek-harness.git',
        commit,
        tag,
        nodeEngine: '>=0.0.0',
      },
      node: { platform: probe.platform, arch: probe.arch },
      pluginDigest,
    })
    writeJson(join(installRoot, 'runtime-manifest.json'), {
      schemaVersion: 1,
      builderVersion: 2,
      app: { version: '0.1.0', edition: 'managed', target },
      dsh: {
        commit,
        commitTime: '2026-08-01T00:00:00Z',
        tag,
        credentialsLayout: 'flat-v0',
        entry: 'dsh-runtime/lib/bin.js',
      },
      native: { platform: probe.platform, arch: probe.arch, nodeAbi: probe.abi },
      pluginDigest,
    })

    execFileSync(process.execPath, [
      'scripts/runtime-manager-entry.mjs',
      'install',
      '--bootstrap', bootstrapPath,
      '--user-runtime', userRuntime,
      '--plugin-payload', join(root, 'unused-payload'),
      '--corepack', join(root, 'unused-corepack'),
      '--commit', commit,
      '--tag', tag,
      '--activation', 'restore',
    ], { cwd: process.cwd(), stdio: 'pipe' })

    expect(readJson(join(userRuntime, 'pending-action.json'))).toEqual({
      schemaVersion: 1,
      action: 'restoreManaged',
      runtimeId,
      commit,
      tag,
    })
  })
})

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown
}
