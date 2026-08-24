import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { run } from './lib/process.mjs'

const root = resolve(import.meta.dirname, '..')
const stage = resolve(root, '.build/stage')
const bootstrap = JSON.parse(readFileSync(resolve(stage, 'bootstrap-manifest.json'), 'utf8'))
const node = resolve(
  root,
  'src-tauri/binaries',
  `node-${bootstrap.app.target}${process.platform === 'win32' ? '.exe' : ''}`,
)
const temporary = mkdtempSync(resolve(tmpdir(), 'dsh-app-managed-runtime-'))

try {
  const managerArgs = [
    resolve(stage, 'runtime-tools/dsh-runtime-manager.mjs'),
    'install',
    '--bootstrap', resolve(stage, 'bootstrap-manifest.json'),
    '--user-runtime', temporary,
    '--plugin-payload', resolve(stage, 'plugin-payload'),
    '--corepack', resolve(stage, 'runtime-tools/corepack/dist/corepack.js'),
    '--commit', bootstrap.dsh.commit,
    '--tag', bootstrap.dsh.tag,
    '--activation', 'current',
  ]
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      run(node, managerArgs, {
        env: { ...process.env, DSH_TELEMETRY_DISABLED: '1' },
      })
      break
    } catch (error) {
      if (attempt === 2) throw error
      // 生产环境中的再次安装会复用 dsh/cache；集成测试保持相同的恢复语义。
      console.warn('Managed runtime install failed; retrying once with the preserved cache...')
    }
  }
  const pointer = JSON.parse(readFileSync(resolve(temporary, 'dsh/current.json'), 'utf8'))
  const installed = resolve(temporary, 'dsh/installs', pointer.runtimeId)
  run(process.execPath, [
    'scripts/test-runtime-integration.mjs',
    '--stage', installed,
    '--node', node,
  ], { cwd: root })
  console.log(`Managed runtime integration passed: ${pointer.runtimeId} / ${pointer.commit}`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
