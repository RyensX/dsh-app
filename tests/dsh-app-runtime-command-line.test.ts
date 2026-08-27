import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  openCommandLine,
  prepareCommandLine,
  resolveRuntimeBinding,
  type PreparedLaunch,
  type RuntimeBinding,
} from '../plugins/dsh-app-runtime/src/launcher.ts'

const temporaryRoots: string[] = []

function temporaryHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-app-runtime-cli-'))
  temporaryRoots.push(root)
  return root
}

const binding: RuntimeBinding = {
  node: "/Applications/DSH App/Node's runtime/bin/node",
  entry: '/Applications/DSH App/Resources/dsh runtime/lib/bin.js',
  dshHome: '/Users/tester/Library/Application Support/DSH App/profile',
  spawnHelper: '/Applications/DSH App/Resources/node-pty/spawn-helper',
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Dsh runtime command-line action', () => {
  it('opens a normal macOS Terminal with only the private wrapper injected', () => {
    const home = temporaryHome()
    const cliRoot = join(home, '.dsh-app', 'runtime', 'cli')
    mkdirSync(cliRoot, { recursive: true })
    writeFileSync(join(cliRoot, 'open-terminal.command'), 'obsolete')

    const launch = prepareCommandLine('darwin', home, binding)
    const command = readFileSync(launch.commandPath, 'utf8')
    const bootstrap = readFileSync(launch.bootstrapPath!, 'utf8')
    const appleScriptCliRoot = launch.cliRoot.replaceAll('\\', '\\\\')

    expect(launch).toMatchObject({
      executable: '/usr/bin/osascript',
      args: [launch.bootstrapPath],
      detached: false,
    })
    expect(existsSync(join(launch.cliRoot, 'open-terminal.command'))).toBe(false)
    expect(bootstrap).toContain('tell application "/System/Applications/Utilities/Terminal.app"')
    expect(bootstrap).toContain(`export PATH='${appleScriptCliRoot}':\\"${'$'}{PATH:-}\\"`)
    expect(command).toContain(`export DSH_HOME='${binding.dshHome}'`)
    expect(command).toContain(`'/Applications/DSH App/Node'\"'\"'s runtime/bin/node'`)
    expect(command).toContain(`'${binding.entry}' "$@"`)
    expect(command).toContain(`export DSH_NODE_PTY_SPAWN_HELPER='${binding.spawnHelper}'`)
    if (process.platform !== 'win32') {
      expect(statSync(launch.cliRoot).mode & 0o777).toBe(0o700)
      expect(statSync(launch.commandPath).mode & 0o777).toBe(0o700)
    }
  })

  it('writes a PowerShell bootstrap and clears an unavailable helper', () => {
    const launch = prepareCommandLine('win32', temporaryHome(), {
      node: 'C:\\Program Files\\DSH App\\node.exe',
      entry: 'C:\\Program Files\\DSH App\\r\\dsh-runtime\\lib\\bin.js',
      dshHome: 'C:\\Users\\100% User\\AppData\\Roaming\\dsh-app\\profile',
    })
    const command = readFileSync(launch.commandPath, 'utf8')
    const bootstrap = readFileSync(launch.bootstrapPath!, 'utf8')

    expect(launch).toMatchObject({
      executable: 'powershell.exe',
      args: ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', launch.bootstrapPath],
      detached: true,
    })
    expect(command).toContain('set "DSH_HOME=C:\\Users\\100%% User')
    expect(command).toContain('set "DSH_NODE_PTY_SPAWN_HELPER="')
    expect(command).toContain('"C:\\Program Files\\DSH App\\node.exe"')
    expect(bootstrap).toContain(`${'$'}env:Path = '${launch.cliRoot};' + ${'$'}env:Path`)
    expect(bootstrap).toContain('Clear-Host')
  })

  it('executes exactly the prepared platform launch', async () => {
    const seen: PreparedLaunch[] = []
    await openCommandLine({
      platform: 'darwin',
      home: temporaryHome(),
      binding,
      execute: async launch => { seen.push(launch) },
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.executable).toBe('/usr/bin/osascript')
    expect(seen[0]?.args).toEqual([seen[0]?.bootstrapPath])
  })

  it('rejects unsupported platforms and incomplete runtime bindings', () => {
    expect(() => prepareCommandLine('linux', temporaryHome(), binding)).toThrow('当前平台不支持')
    expect(() => resolveRuntimeBinding('/node', '', { DSH_HOME: '/profile' })).toThrow('运行时入口不可用')
    expect(() => resolveRuntimeBinding('/node', '/bin.js', {})).toThrow('未设置 DSH_HOME')
    expect(() => resolveRuntimeBinding('node', '/bin.js', { DSH_HOME: '/profile' })).toThrow('必须是绝对路径')
  })
})
