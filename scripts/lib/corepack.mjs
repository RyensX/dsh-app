import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { run } from './process.mjs'

/**
 * 直接通过 Node 执行 Corepack 入口，避免 Windows 将 corepack.cmd 当作可执行文件启动。
 */
export function resolveCorepackEntry(nodeExecutable = process.execPath) {
  const nodeRoot = dirname(nodeExecutable)
  const candidates = [
    resolve(nodeRoot, 'node_modules/corepack/dist/corepack.js'),
    resolve(nodeRoot, '../lib/node_modules/corepack/dist/corepack.js'),
  ]
  const entry = candidates.find(candidate => existsSync(candidate))
  if (!entry) throw new Error(`Corepack entrypoint is missing for Node: ${nodeExecutable}`)
  return entry
}

export function runCorepack(args, options = {}) {
  const nodeExecutable = options.nodeExecutable ?? process.execPath
  const corepackEntry = options.corepackEntry ?? resolveCorepackEntry(nodeExecutable)
  const {
    nodeExecutable: _nodeExecutable,
    corepackEntry: _corepackEntry,
    ...runOptions
  } = options
  return run(nodeExecutable, [corepackEntry, ...args], runOptions)
}
