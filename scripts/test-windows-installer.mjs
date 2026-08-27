import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs, requiredArg } from './lib/args.mjs'
import { run } from './lib/process.mjs'

if (process.platform !== 'win32') throw new Error('Windows installer smoke test requires Windows')
if (process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true') {
  throw new Error('Windows installer smoke test is restricted to an ephemeral GitHub Actions runner')
}

const root = resolve(import.meta.dirname, '..')
const args = parseArgs(process.argv.slice(2))
const edition = requiredArg(args, 'edition')
if (!['bundled', 'lite'].includes(edition)) throw new Error(`invalid edition: ${edition}`)
const installer = resolve(requiredArg(args, 'path'))
if (!existsSync(installer)) throw new Error(`Windows installer is missing: ${installer}`)
const localAppData = process.env.LOCALAPPDATA
if (!localAppData) throw new Error('LOCALAPPDATA is unavailable')
const installRoot = resolve(localAppData, 'DSH App')
if (existsSync(installRoot)) {
  throw new Error(`refusing to replace an existing DSH App installation: ${installRoot}`)
}

let failure = null
try {
  run(installer, ['/S'])
  if (!existsSync(installRoot)) throw new Error(`silent installer did not create ${installRoot}`)
  run(process.execPath, [
    'scripts/verify-artifact.mjs',
    '--edition', edition,
    '--path', installRoot,
  ], { cwd: root })
  if (edition === 'bundled') {
    run(process.execPath, [
      'scripts/test-runtime-integration.mjs',
      '--stage', resolve(installRoot, 'r'),
      '--node', resolve(installRoot, 'node.exe'),
    ], { cwd: root })
  }
  console.log(`Windows installer smoke test passed: ${edition} / ${installRoot}`)
} catch (error) {
  failure = error
} finally {
  const uninstaller = resolve(installRoot, 'uninstall.exe')
  if (existsSync(uninstaller)) {
    try {
      run(uninstaller, ['/S'])
      await waitForRemoval(installRoot)
    } catch (error) {
      if (!failure) failure = error
      else console.error(`Windows installer cleanup also failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
if (failure) throw failure

async function waitForRemoval(path) {
  const deadline = Date.now() + 15_000
  while (existsSync(path) && Date.now() < deadline) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  if (existsSync(path)) throw new Error(`silent uninstaller did not remove ${path}`)
}
