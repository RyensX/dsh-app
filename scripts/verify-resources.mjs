import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { assertPluginPayloadIdentity } from './lib/plugin-payload-contract.mjs'
import { readRemotePluginManifest, selectRemotePlugins } from './lib/remote-plugins.mjs'
import { assertRuntimeShape, verifySymlinkClosure } from './lib/runtime.mjs'
import { targetInfo } from './lib/targets.mjs'

const root = resolve(import.meta.dirname, '..')
const stage = resolve(root, '.build/stage')
const bootstrapPath = resolve(stage, 'bootstrap-manifest.json')
if (!existsSync(bootstrapPath)) throw new Error('bootstrap-manifest.json is missing')
const bootstrap = JSON.parse(readFileSync(bootstrapPath, 'utf8'))
if (bootstrap.schemaVersion !== 1 || !['bundled', 'lite'].includes(bootstrap.app?.edition)) {
  throw new Error('bootstrap-manifest.json has an unsupported shape')
}
for (const required of [
  'licenses/DSH-App-AGPL-3.0.txt',
  'plugin-payload/payload.json',
  'plugin-payload/plugins/index.json',
  'remote-plugins.json',
  'dsh-app.remote-plugins.schema.json',
  'runtime-tools/dsh-runtime-manager.mjs',
  'runtime-tools/corepack/dist/corepack.js',
]) {
  if (!existsSync(resolve(stage, required))) throw new Error(`staged resource is missing: ${required}`)
}
const appLicense = readFileSync(resolve(stage, 'licenses/DSH-App-AGPL-3.0.txt'), 'utf8')
const appLicenseMarkers = [
  'GNU AFFERO GENERAL PUBLIC LICENSE',
  '13. Remote Network Interaction',
  'END OF TERMS AND CONDITIONS',
]
if (appLicenseMarkers.some(marker => !appLicense.includes(marker))) {
  throw new Error('staged DSH App AGPL license text is invalid')
}
const payload = JSON.parse(readFileSync(resolve(stage, 'plugin-payload/payload.json'), 'utf8'))
const payloadIndex = JSON.parse(readFileSync(resolve(stage, 'plugin-payload/plugins/index.json'), 'utf8'))
assertPluginPayloadIdentity({ bootstrap, payload, payloadIndex })
const remotePlugins = readRemotePluginManifest(resolve(stage, 'remote-plugins.json'))
const selectedRemotePlugins = selectRemotePlugins(
  remotePlugins,
  targetInfo(bootstrap.app.target).appTarget,
  bootstrap.app.edition,
)
if (selectedRemotePlugins.plugins.length !== remotePlugins.plugins.length) {
  throw new Error('staged remote plugin catalog contains another edition or target')
}
for (const plugin of remotePlugins.plugins) {
  if (payload.plugins.some(bundled => bundled.id === plugin.name)) {
    throw new Error(`remote plugin conflicts with an App-bundled plugin: ${plugin.name}`)
  }
  for (const root of ['plugin-payload', 'dsh-runtime']) {
    if (existsSync(resolve(stage, root, 'node_modules', plugin.name, 'package.json'))) {
      throw new Error(`remote plugin source leaked into packaged resources: ${plugin.name}`)
    }
  }
}

const runtime = resolve(stage, 'dsh-runtime')
const runtimeManifest = resolve(stage, 'runtime-manifest.json')
if (bootstrap.app.edition === 'bundled') {
  assertRuntimeShape(runtime)
  verifySymlinkClosure(runtime)
  if (!existsSync(runtimeManifest)) throw new Error('Bundled runtime-manifest.json is missing')
  const manifest = JSON.parse(readFileSync(runtimeManifest, 'utf8'))
  if (
    manifest.app?.edition !== 'bundled'
    || manifest.app?.target !== bootstrap.app.target
    || manifest.dsh?.commit !== bootstrap.dsh.commit
    || manifest.pluginDigest !== bootstrap.pluginDigest
  ) {
    throw new Error('Bundled runtime does not match the submodule bootstrap manifest')
  }
} else if (existsSync(runtime) || existsSync(runtimeManifest)) {
  throw new Error('Lite resources unexpectedly contain a dsh runtime')
}

console.log(`Resources verified: ${bootstrap.app.edition} / ${bootstrap.dsh.version} / ${bootstrap.app.target}`)
