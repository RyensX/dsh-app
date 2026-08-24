import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertRuntimeChannel,
  readRuntimeChannel,
  writeRuntimeChannel,
} from '../plugins/dsh-app-runtime/src/runtime-channel.ts'

const fixtures: string[] = []

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Dsh runtime update channel', () => {
  it('defaults to stable and preserves unrelated App configuration', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-app-channel-'))
    fixtures.push(root)
    const path = join(root, 'config.json')
    writeFileSync(path, '{"schemaVersion":1,"other":{"enabled":true}}\n')

    expect(readRuntimeChannel(path)).toBe('stable')
    writeRuntimeChannel(path, 'latest')
    expect(readRuntimeChannel(path)).toBe('latest')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      schemaVersion: 1,
      other: { enabled: true },
      dshRuntime: { channel: 'latest' },
    })
    // Windows 依赖用户目录继承 ACL，不提供可比较的 POSIX mode bits。
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('rejects invalid channels and malformed App configuration', () => {
    expect(() => assertRuntimeChannel('nightly')).toThrow('DSH_APP_INVALID_CHANNEL')
    const root = mkdtempSync(join(tmpdir(), 'dsh-app-channel-invalid-'))
    fixtures.push(root)
    const path = join(root, 'config.json')
    writeFileSync(path, '{"schemaVersion":2}\n')
    expect(() => readRuntimeChannel(path)).toThrow('DSH_APP_CONFIG_INVALID')
  })
})
