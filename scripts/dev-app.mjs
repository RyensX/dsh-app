import { resolve } from 'node:path'
import { parseArgs, requiredArg } from './lib/args.mjs'
import { runCorepack } from './lib/corepack.mjs'
import { run } from './lib/process.mjs'
import { hostTarget } from './lib/targets.mjs'

const root = resolve(import.meta.dirname, '..')
const args = parseArgs(process.argv.slice(2))
const edition = requiredArg(args, 'edition')
if (!['bundled', 'lite'].includes(edition)) throw new Error(`invalid edition: ${edition}`)
const target = hostTarget()

run(process.execPath, [
  'scripts/prepare-resources.mjs',
  '--edition', edition,
  '--target', target,
], { cwd: root })
runCorepack([
  'pnpm@11.7.0', 'exec', 'tauri', 'dev',
  '--features', edition,
  '--target', target,
  '--config', `src-tauri/tauri.${edition}.conf.json`,
], { cwd: root })
