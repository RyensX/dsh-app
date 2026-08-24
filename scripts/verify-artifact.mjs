import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { basename, relative, resolve, sep } from 'node:path'
import { parseArgs, requiredArg } from './lib/args.mjs'
import { assertPluginPayloadIdentity } from './lib/plugin-payload-contract.mjs'
import { readRemotePluginManifest, selectRemotePlugins } from './lib/remote-plugins.mjs'
import { targetInfo } from './lib/targets.mjs'

// Validate the unpacked closure, including the intentional Bundled/Lite asymmetry.

const args = parseArgs(process.argv.slice(2))
const edition = requiredArg(args, 'edition')
if (!['bundled', 'lite'].includes(edition)) throw new Error(`invalid edition: ${edition}`)
const artifact = resolve(requiredArg(args, 'path'))
if (!existsSync(artifact)) throw new Error(`artifact path does not exist: ${artifact}`)

const files = []
function walk(path) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) {
    const target = realpathSync(path)
    const root = realpathSync(artifact)
    if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error(`external artifact symlink: ${path}`)
  } else if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) walk(resolve(path, entry))
  } else if (stat.isFile()) {
    files.push(path)
  }
}
walk(artifact)

const relativePath = file => relative(artifact, file).split(sep).join('/')
const pathEndsWith = (file, suffix) => {
  const path = relativePath(file)
  return path === suffix || path.endsWith(`/${suffix}`)
}
const find = suffix => files.find(file => pathEndsWith(file, suffix))
const contains = marker => files.some(file => {
  const path = relativePath(file)
  if (/(?:^|\/)dsh-runtime\//u.test(path)) return false
  return readFileSync(file).includes(Buffer.from(marker))
})

for (const required of [
  'resources/licenses/DSH-App-AGPL-3.0.txt',
  'resources/bootstrap-manifest.json',
  'resources/plugin-payload/payload.json',
  'resources/plugin-payload/plugins/index.json',
  'resources/remote-plugins.json',
  'resources/dsh-app.remote-plugins.schema.json',
  'resources/runtime-tools/dsh-runtime-manager.mjs',
  'resources/runtime-tools/corepack/dist/corepack.js',
]) {
  if (!find(required)) throw new Error(`artifact is missing ${required}`)
}
const appLicense = readFileSync(find('resources/licenses/DSH-App-AGPL-3.0.txt'), 'utf8')
const appLicenseMarkers = [
  'GNU AFFERO GENERAL PUBLIC LICENSE',
  '13. Remote Network Interaction',
  'END OF TERMS AND CONDITIONS',
]
if (appLicenseMarkers.some(marker => !appLicense.includes(marker))) {
  throw new Error('artifact DSH App AGPL license text is invalid')
}
const bootstrap = JSON.parse(readFileSync(find('resources/bootstrap-manifest.json'), 'utf8'))
const payload = JSON.parse(readFileSync(find('resources/plugin-payload/payload.json'), 'utf8'))
const payloadIndex = JSON.parse(readFileSync(find('resources/plugin-payload/plugins/index.json'), 'utf8'))
const remotePlugins = readRemotePluginManifest(find('resources/remote-plugins.json'))
if (bootstrap.app?.edition !== edition) {
  throw new Error(`artifact edition mismatch: expected ${edition}, found ${String(bootstrap.app?.edition)}`)
}
assertPluginPayloadIdentity({ bootstrap, payload, payloadIndex })
const selectedRemotePlugins = selectRemotePlugins(
  remotePlugins,
  targetInfo(bootstrap.app.target).appTarget,
  edition,
)
if (selectedRemotePlugins.plugins.length !== remotePlugins.plugins.length) {
  throw new Error('artifact remote plugin catalog contains another edition or target')
}
for (const plugin of remotePlugins.plugins) {
  if (payload.plugins.some(bundled => bundled.id === plugin.name)) {
    throw new Error(`remote plugin conflicts with an App-bundled plugin: ${plugin.name}`)
  }
  if (
    find(`resources/plugin-payload/node_modules/${plugin.name}/package.json`)
    || find(`resources/dsh-runtime/node_modules/${plugin.name}/package.json`)
  ) {
    throw new Error(`remote plugin source leaked into artifact: ${plugin.name}`)
  }
}
if (!/^[a-f0-9]{40}$/u.test(bootstrap.dsh?.commit ?? '')) throw new Error('bootstrap dsh commit is invalid')
if (!bootstrap.dsh?.version) throw new Error('bootstrap dsh version metadata is incomplete')
if (bootstrap.dsh.tag !== null && !/^dsh-v[0-9A-Za-z.+-]+$/u.test(bootstrap.dsh.tag ?? '')) {
  throw new Error('bootstrap dsh tag is invalid')
}
if (!bootstrap.node?.version || !/^[a-f0-9]{64}$/u.test(bootstrap.node?.sha256 ?? '')) {
  throw new Error('bootstrap Node provenance is incomplete')
}

const executableNode = files.some(file => (
  ['node', 'node.exe'].includes(basename(file).toLowerCase())
  && !/(?:^|\/)dsh-runtime\//u.test(relativePath(file))
))
const runtimePackage = find('resources/dsh-runtime/package.json')
const runtimeManifestPath = find('resources/runtime-manifest.json')

if (edition === 'bundled') {
  if (!executableNode) throw new Error('Bundled artifact has no Node executable')
  if (!runtimePackage || !runtimeManifestPath) throw new Error('Bundled artifact has no embedded dsh runtime')
  const manifest = JSON.parse(readFileSync(runtimeManifestPath, 'utf8'))
  if (
    manifest.app?.edition !== 'bundled'
    || manifest.app?.target !== bootstrap.app.target
    || manifest.dsh?.commit !== bootstrap.dsh.commit
    || manifest.pluginDigest !== bootstrap.pluginDigest
  ) {
    throw new Error('Bundled runtime does not match its submodule bootstrap commit')
  }
  for (const forbidden of ['lite.json', 'NODE_DOWNLOAD_FAILED', 'NODE_CHECKSUM_MISMATCH', 'lite.html']) {
    if (contains(forbidden)) throw new Error(`Bundled artifact contains Lite-only marker: ${forbidden}`)
  }
} else {
  if (executableNode) throw new Error('Lite artifact unexpectedly contains a Node executable')
  if (runtimePackage || runtimeManifestPath || files.some(file => /(?:^|\/)dsh-runtime\//u.test(relativePath(file)))) {
    throw new Error('Lite artifact unexpectedly contains dsh')
  }
  for (const required of ['lite.json', 'NODE_DOWNLOAD_FAILED', 'NODE_CHECKSUM_MISMATCH', 'lite.html']) {
    if (!contains(required)) throw new Error(`Lite artifact is missing bootstrap marker: ${required}`)
  }
}

if (!files.some(file => pathEndsWith(file, 'plugin-payload/node_modules/dsh-app-runtime/package.json'))) {
  throw new Error('artifact does not contain the dsh-app-runtime plugin')
}

for (const file of files) {
  const path = relativePath(file)
  if (/dsh-runtime\/(?:apps|packages|vendor|website|\.git)\//u.test(path)
    || /dsh-runtime\/node_modules\/\.pnpm\/[^/]+\/node_modules\/@deepseek-ai\/[^/]+\/src\//u.test(path)) {
    throw new Error(`dsh source leaked into artifact: ${path}`)
  }
  if (/dsh-runtime\/(?:pnpm-lock\.yaml|pnpm-workspace\.yaml|node_modules\/(?:\.modules\.yaml|\.pnpm\/lock\.yaml|\.pnpm-workspace-state-v1\.json))$/u.test(path)) {
    throw new Error(`dsh build metadata leaked into artifact: ${path}`)
  }
}
if (runtimePackage && readFileSync(runtimePackage, 'utf8').includes('file:')) {
  throw new Error('dsh runtime package.json contains a temporary file dependency')
}
console.log(`Artifact verified: ${edition}, ${files.length} files`)
