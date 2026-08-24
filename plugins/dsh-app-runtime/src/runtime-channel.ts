import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type RuntimeChannel = 'stable' | 'latest'

export function assertRuntimeChannel(value: unknown): asserts value is RuntimeChannel {
  if (value !== 'stable' && value !== 'latest') throw new Error('DSH_APP_INVALID_CHANNEL')
}

export function readRuntimeChannel(configPath: string): RuntimeChannel {
  const config = readConfig(configPath)
  const value = isRecord(config.dshRuntime) ? config.dshRuntime.channel : undefined
  if (value === undefined) return 'stable'
  assertRuntimeChannel(value)
  return value
}

export function writeRuntimeChannel(configPath: string, channel: RuntimeChannel): void {
  assertRuntimeChannel(channel)
  const config = readConfig(configPath)
  const runtime = isRecord(config.dshRuntime) ? config.dshRuntime : {}
  atomicJson(configPath, {
    ...config,
    schemaVersion: 1,
    dshRuntime: { ...runtime, channel },
  })
}

function readConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return { schemaVersion: 1 }
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!isRecord(value) || value.schemaVersion !== 1) throw new Error('shape')
    return value
  } catch {
    throw new Error('DSH_APP_CONFIG_INVALID')
  }
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${process.pid}`
  const backup = `${path}.previous-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  let movedPrevious = false
  try {
    try {
      renameSync(path, backup)
      movedPrevious = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    renameSync(temporary, path)
    rmSync(backup, { force: true })
  } catch (error) {
    rmSync(temporary, { force: true })
    if (movedPrevious) {
      try { renameSync(backup, path) } catch {}
    }
    throw error
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
