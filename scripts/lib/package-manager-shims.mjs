import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * dsh 的 profile 命令会直接查找 pnpm，部分 package scripts 还会使用
 * `npm run`/`npx`。App 不携带 npm；这些 shim 全部转发给同一个固定版本的 pnpm。
 */
export function writeNpmCompatibilityShims({
  directory,
  nodeExecutable,
  corepack,
  packageManager = 'pnpm@11.7.0',
}) {
  const root = resolve(directory)
  mkdirSync(root, { recursive: true })
  const commands = [
    { name: 'pnpm', prefix: [] },
    { name: 'npm', prefix: [] },
    { name: 'npx', prefix: ['dlx'] },
  ]
  for (const command of commands) {
    const args = [corepack, packageManager, ...command.prefix]
    const posix = resolve(root, command.name)
    writeFileSync(posix, [
      '#!/bin/sh',
      `exec ${shellQuote(nodeExecutable)} ${args.map(shellQuote).join(' ')} "$@"`,
      '',
    ].join('\n'), { mode: 0o755 })
    chmodSync(posix, 0o755)

    const windows = resolve(root, `${command.name}.cmd`)
    writeFileSync(windows, [
      '@echo off',
      `${cmdQuote(nodeExecutable)} ${args.map(cmdQuote).join(' ')} %*`,
      '',
    ].join('\r\n'))
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`
}

function cmdQuote(value) {
  return `"${String(value).replaceAll('%', '%%').replaceAll('"', '""')}"`
}
