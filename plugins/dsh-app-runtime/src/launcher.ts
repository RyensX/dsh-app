import { execFile, spawn } from 'node:child_process'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export interface RuntimeBinding {
  readonly node: string
  readonly entry: string
  readonly dshHome: string
  readonly spawnHelper?: string
}

export interface PreparedLaunch {
  readonly platform: 'darwin' | 'win32'
  readonly executable: string
  readonly args: readonly string[]
  readonly detached: boolean
  readonly cliRoot: string
  readonly commandPath: string
  readonly bootstrapPath?: string
}

export interface OpenCommandLineOptions {
  readonly platform?: NodeJS.Platform
  readonly home?: string
  readonly binding?: RuntimeBinding
  readonly execute?: (launch: PreparedLaunch) => Promise<void>
}

/** 固定当前 App 管理的 Node、dsh 入口和 profile，避免终端依赖 App 进程继续存活。 */
export function resolveRuntimeBinding(
  node: string = process.execPath,
  entry: string | undefined = process.argv[1],
  environment: NodeJS.ProcessEnv = process.env,
): RuntimeBinding {
  assertAbsolutePath('Node 可执行文件', node)
  if (entry === undefined || entry.trim() === '') throw new Error('当前 dsh 运行时入口不可用')
  assertAbsolutePath('dsh 运行时入口', entry)

  const dshHome = environment.DSH_HOME
  if (dshHome === undefined || dshHome.trim() === '') throw new Error('当前 dsh 运行时未设置 DSH_HOME')
  assertAbsolutePath('DSH_HOME', dshHome)

  const helper = environment.DSH_NODE_PTY_SPAWN_HELPER
  if (helper !== undefined && helper.trim() !== '') assertAbsolutePath('node-pty helper', helper)
  return {
    node,
    entry,
    dshHome,
    ...(helper === undefined || helper.trim() === '' ? {} : { spawnHelper: helper }),
  }
}

/** 在用户私有目录生成包装命令和平台终端引导脚本。 */
export function prepareCommandLine(
  platform: NodeJS.Platform,
  home: string,
  binding: RuntimeBinding,
): PreparedLaunch {
  if (platform !== 'darwin' && platform !== 'win32') {
    throw new Error(`当前平台不支持打开命令行：${platform}`)
  }
  assertAbsolutePath('用户目录', home)

  const cliRoot = join(home, '.dsh-app', 'runtime', 'cli')
  mkdirSync(cliRoot, { recursive: true, mode: 0o700 })

  if (platform === 'darwin') {
    chmodSync(cliRoot, 0o700)
    const commandPath = join(cliRoot, 'dsh')
    const bootstrapPath = join(cliRoot, 'open-terminal.applescript')
    writePrivateExecutable(commandPath, macCommand(binding))
    writeFileSync(bootstrapPath, macTerminalBootstrap(cliRoot), { encoding: 'utf8', mode: 0o600 })
    rmSync(join(cliRoot, 'open-terminal.command'), { force: true })
    return {
      platform,
      executable: '/usr/bin/osascript',
      args: [bootstrapPath],
      detached: false,
      cliRoot,
      commandPath,
      bootstrapPath,
    }
  }

  const commandPath = join(cliRoot, 'dsh.cmd')
  const bootstrapPath = join(cliRoot, 'open-powershell.ps1')
  writeFileSync(commandPath, windowsCommand(binding), { encoding: 'utf8', mode: 0o600 })
  writeFileSync(bootstrapPath, windowsBootstrap(cliRoot), { encoding: 'utf8', mode: 0o600 })
  return {
    platform,
    executable: 'powershell.exe',
    args: ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', bootstrapPath],
    detached: true,
    cliRoot,
    commandPath,
    bootstrapPath,
  }
}

/** 创建脚本后启动平台终端；调用方不能覆盖任何运行时路径。 */
export async function openCommandLine(options: OpenCommandLineOptions = {}): Promise<void> {
  const launch = prepareCommandLine(
    options.platform ?? process.platform,
    options.home ?? homedir(),
    options.binding ?? resolveRuntimeBinding(),
  )
  await (options.execute ?? executeLaunch)(launch)
}

function writePrivateExecutable(path: string, content: string): void {
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o700 })
  chmodSync(path, 0o700)
}

function macCommand(binding: RuntimeBinding): string {
  const helper = binding.spawnHelper === undefined
    ? 'unset DSH_NODE_PTY_SPAWN_HELPER'
    : `export DSH_NODE_PTY_SPAWN_HELPER=${shellQuote(binding.spawnHelper)}`
  return `#!/bin/sh
export DSH_HOME=${shellQuote(binding.dshHome)}
${helper}
exec ${shellQuote(binding.node)} ${shellQuote(binding.entry)} "$@"
`
}

function macTerminalBootstrap(cliRoot: string): string {
  // Terminal 的 login 进程会重置 PATH，因此必须等交互式 shell 就绪后再注入。
  const setupCommand = `export PATH=${shellQuote(cliRoot)}:"${'$'}{PATH:-}"; printf '\\033[3J\\033[H\\033[2J'`
  return `tell application "/System/Applications/Utilities/Terminal.app"
  do script ${appleScriptQuote(setupCommand)}
  activate
end tell
`
}

function windowsCommand(binding: RuntimeBinding): string {
  const helper = binding.spawnHelper === undefined ? '' : batchValue(binding.spawnHelper)
  return `@echo off\r
setlocal\r
set "DSH_HOME=${batchValue(binding.dshHome)}"\r
set "DSH_NODE_PTY_SPAWN_HELPER=${helper}"\r
"${batchValue(binding.node)}" "${batchValue(binding.entry)}" %*\r
exit /b %ERRORLEVEL%\r
`
}

function windowsBootstrap(cliRoot: string): string {
  return `${'$'}env:Path = ${powerShellQuote(`${cliRoot};`)} + ${'$'}env:Path\r
Set-Location -LiteralPath ${'$'}HOME\r
Clear-Host\r
`
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function appleScriptQuote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function powerShellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function batchValue(value: string): string {
  return value.replaceAll('%', '%%')
}

function assertAbsolutePath(label: string, value: string): void {
  if (!isAbsolute(value)) throw new Error(`${label}必须是绝对路径`)
}

function executeLaunch(launch: PreparedLaunch): Promise<void> {
  if (launch.detached) {
    return new Promise((resolve, reject) => {
      const child = spawn(launch.executable, [...launch.args], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      })
      child.once('error', reject)
      child.once('spawn', () => {
        child.unref()
        resolve()
      })
    })
  }

  return new Promise((resolve, reject) => {
    execFile(launch.executable, [...launch.args], { windowsHide: false }, (error) => {
      if (error === null) resolve()
      else reject(error)
    })
  })
}
