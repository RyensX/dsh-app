import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { parseArgs } from './lib/args.mjs'

const root = resolve(import.meta.dirname, '..')
const args = parseArgs(process.argv.slice(2))
const stage = resolve(args.get('stage') ?? resolve(root, '.build/stage'))
const manifest = JSON.parse(readFileSync(resolve(stage, 'runtime-manifest.json'), 'utf8'))
const runtime = resolve(stage, 'dsh-runtime')
const entry = resolve(stage, manifest.dsh.entry)
const helper = manifest.native.nodePtySpawnHelper
  ? resolve(runtime, manifest.native.nodePtySpawnHelper)
  : null
const node = args.get('node') ?? (manifest.app.edition === 'bundled'
  ? resolve(root, 'src-tauri/binaries', `node-${manifest.app.target}${process.platform === 'win32' ? '.exe' : ''}`)
  : process.execPath)

const temporary = mkdtempSync(resolve(tmpdir(), 'dsh-app-integration-'))
const home = resolve(temporary, 'profile')
const workspace = resolve(temporary, 'workspace')
mkdirSync(home, { recursive: true })
mkdirSync(workspace, { recursive: true })
const pluginIndex = JSON.parse(readFileSync(resolve(runtime, 'plugins/index.json'), 'utf8'))
const patch = resolve(temporary, 'plugins.patch.json')
const insert = pluginIndex.plugins.map(plugin => ({
  id: plugin.id,
  name: plugin.id,
  config: plugin.config,
}))
writeFileSync(patch, `${JSON.stringify(insert.length ? [{ insert }] : [], null, 2)}\n`)

const environment = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
delete environment.NODE_OPTIONS
delete environment.NODE_PATH
if (helper) environment.DSH_NODE_PTY_SPAWN_HELPER = helper

const child = spawn(node, [entry, '--profile', 'web', '--patch', patch, '--port', '0', '--no-open'], {
  cwd: workspace,
  env: environment,
  detached: process.platform !== 'win32',
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
let output = ''
child.stdout.on('data', chunk => { output += chunk.toString() })
child.stderr.on('data', chunk => { output += chunk.toString() })

try {
  const readyUrl = await waitForReady(child, () => output)
  const response = await fetch(readyUrl)
  if (response.status !== 200) throw new Error(`dsh homepage returned HTTP ${response.status}`)
  const homepage = await response.text()
  for (const plugin of pluginIndex.plugins) {
    const packageManifest = JSON.parse(readFileSync(resolve(runtime, 'node_modules', plugin.id, 'package.json'), 'utf8'))
    if (packageManifest.dsh?.client?.platform !== 'web') continue
    if (!homepage.includes(`\"id\":\"${plugin.id}\"`)) {
      throw new Error(`dsh homepage boot graph is missing client plugin ${plugin.id}`)
    }
    const bundleUrl = new URL(`/plugins/${plugin.id}/client.js`, readyUrl)
    const bundle = await fetch(bundleUrl)
    if (bundle.status !== 200) throw new Error(`client plugin bundle returned HTTP ${bundle.status}: ${plugin.id}`)
    if (!(await bundle.text()).includes(`id: \"${plugin.id}\"`)) {
      throw new Error(`client plugin bundle has the wrong module handoff: ${plugin.id}`)
    }
  }
  await stopTree(child)
  console.log(`Runtime integration passed: ${readyUrl}, ${pluginIndex.plugins.length} plugin(s)`)
} finally {
  if (child.exitCode === null) await stopTree(child).catch(() => {})
  rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}

async function waitForReady(processHandle, currentOutput) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+)/u.exec(currentOutput())
    if (match?.[1]) return match[1]
    if (processHandle.exitCode !== null) throw new Error(`dsh exited before readiness (${processHandle.exitCode}):\n${currentOutput()}`)
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
  }
  throw new Error(`dsh did not become ready in 30 seconds:\n${currentOutput()}`)
}

async function stopTree(processHandle) {
  if (processHandle.exitCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(processHandle.pid), '/T', '/F'], { windowsHide: true })
  } else {
    process.kill(-processHandle.pid, 'SIGTERM')
  }
  const completed = new Promise(resolvePromise => processHandle.once('exit', resolvePromise))
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('dsh did not exit after SIGTERM')), 7000))
  await Promise.race([completed, timeout])
}
