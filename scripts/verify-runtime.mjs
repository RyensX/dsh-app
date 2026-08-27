import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { assertRuntimeShape, verifySymlinkClosure } from './lib/runtime.mjs'

const root = resolve(import.meta.dirname, '..')
const stage = resolve(root, '.build/stage')
const runtime = resolve(stage, 'dsh-runtime')
assertRuntimeShape(runtime, { nodeModulesLayout: 'hoisted' })
verifySymlinkClosure(runtime)
const manifestPath = resolve(stage, 'runtime-manifest.json')
if (!existsSync(manifestPath)) throw new Error('runtime-manifest.json is missing')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (manifest.schemaVersion !== 1 || manifest.dsh?.entry !== 'dsh-runtime/lib/bin.js') {
  throw new Error('runtime-manifest.json has an unsupported shape')
}
console.log(`Runtime verified: ${manifest.dsh.version} / ${manifest.app.edition} / ${manifest.app.target}`)
