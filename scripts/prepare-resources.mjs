import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, resolve } from 'node:path'
import { build } from 'esbuild'
import semver from 'semver'
import { parseArgs } from './lib/args.mjs'
import { runCorepack } from './lib/corepack.mjs'
import { detectDshCredentialsLayout } from './lib/credentials-profile.mjs'
import { readDshSubmoduleRepository } from './lib/dsh-git.mjs'
import { run } from './lib/process.mjs'
import { hostTarget, targetInfo, assertNativeTarget } from './lib/targets.mjs'
import { prepareNodeDistribution } from './lib/node-download.mjs'
import { buildPluginPayload, injectPluginPayload } from './lib/plugins.mjs'
import { readRemotePluginManifest, selectRemotePlugins } from './lib/remote-plugins.mjs'
import {
  completeWorkspaceRuntimeClosure,
  enableInjectedWorkspacePackages,
} from './lib/workspace-runtime.mjs'
import {
  assertCleanSubmodule,
  assertRuntimeShape,
  collectLicenseInventory,
  findNodePtyPackage,
  findSpawnHelper,
  readJson,
  sanitizeProductionRuntime,
  writeLicenses,
} from './lib/runtime.mjs'

const root = resolve(import.meta.dirname, '..')
const args = parseArgs(process.argv.slice(2))
const triple = args.get('target') ?? hostTarget()
const edition = args.get('edition') ?? 'bundled'
if (!['bundled', 'lite'].includes(edition)) throw new Error(`invalid edition: ${edition}`)
const target = targetInfo(triple)
assertNativeTarget(target)

const dshRoot = resolve(root, 'dsh')
assertCleanSubmodule(dshRoot)
const repository = readDshSubmoduleRepository(root)
const commit = run('git', ['rev-parse', 'HEAD'], { cwd: dshRoot, capture: true })
const commitTime = run('git', ['show', '-s', '--format=%cI', commit], { cwd: dshRoot, capture: true })
const dshPackage = readJson(resolve(dshRoot, 'package.json'))
const cliPackage = readJson(resolve(dshRoot, 'apps/cli/package.json'))
const credentialsLayout = detectDshCredentialsLayout(dshRoot)
const nodeEngine = dshPackage.engines?.node
if (typeof nodeEngine !== 'string') throw new Error('dsh package.json does not declare engines.node')
const expectedTag = `dsh-v${cliPackage.version}`
const tags = run('git', ['tag', '--points-at', 'HEAD'], { cwd: dshRoot, capture: true }).split(/\r?\n/u)
const tag = tags.includes(expectedTag) ? expectedTag : null

const nodeConfig = readJson(resolve(root, 'build/node.json'))
const pinnedNode = String(nodeConfig.version)
if (!semver.satisfies(pinnedNode, nodeEngine)) {
  throw new Error(`Node v${pinnedNode} no longer satisfies dsh engines.node ${nodeEngine}`)
}
const nodeDistribution = await prepareNodeDistribution({
  root,
  target,
  version: pinnedNode,
  baseUrl: String(nodeConfig.baseUrl),
  copySidecar: edition === 'bundled',
})
if (edition === 'lite') {
  rmSync(resolve(root, 'src-tauri/binaries', `node-${target.triple}${process.platform === 'win32' ? '.exe' : ''}`), { force: true })
}

const currentNode = run(process.execPath, ['--version'], { capture: true }).replace(/^v/u, '')
if (!semver.satisfies(currentNode, nodeEngine)) {
  throw new Error(`build Node v${currentNode} does not satisfy dsh engines.node ${nodeEngine}`)
}

const stage = resolve(root, '.build/stage')
rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })

// 远程插件只把当前 edition/target 的声明写入资源，实际包始终在用户机器上安装。
const remotePlugins = selectRemotePlugins(
  readRemotePluginManifest(resolve(root, 'remote-plugins.json')),
  target.appTarget,
  edition,
)
writeFileSync(resolve(stage, 'remote-plugins.json'), `${JSON.stringify(remotePlugins, null, 2)}\n`)

const payloadRoot = resolve(stage, 'plugin-payload')
const payload = await buildPluginPayload({
  pluginsRoot: resolve(root, 'plugins'),
  payloadRoot,
  platform: target.appTarget,
  targetTriple: triple,
  edition,
})

const toolsRoot = resolve(stage, 'runtime-tools')
mkdirSync(toolsRoot, { recursive: true })
cpSync(nodeDistribution.corepack, resolve(toolsRoot, 'corepack'), { recursive: true })
await build({
  entryPoints: [resolve(root, 'scripts/runtime-manager-entry.mjs')],
  outfile: resolve(toolsRoot, 'dsh-runtime-manager.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22.19',
  sourcemap: false,
  legalComments: 'eof',
  banner: {
    js: "import { createRequire as __dshAppCreateRequire } from 'node:module'; const require = __dshAppCreateRequire(import.meta.url);",
  },
})

const bootstrap = {
  schemaVersion: 1,
  app: {
    version: readJson(resolve(root, 'package.json')).version,
    edition,
    target: triple,
  },
  dsh: {
    repository,
    commit,
    commitTime,
    tag,
    version: cliPackage.version,
    nodeEngine,
    credentialsLayout,
    packageManager: 'pnpm@11.7.0',
  },
  node: {
    version: pinnedNode,
    baseUrl: String(nodeConfig.baseUrl),
    archive: nodeDistribution.archive,
    sha256: nodeDistribution.sha256,
    platform: target.nodePlatform,
    arch: target.nodeArch,
  },
  pluginDigest: payload.digest,
}
writeFileSync(resolve(stage, 'bootstrap-manifest.json'), `${JSON.stringify(bootstrap, null, 2)}\n`)

let inventory = []
if (edition === 'bundled') {
  const cloneRoot = resolve(root, '.build/dsh-src', commit)
  rmSync(cloneRoot, { recursive: true, force: true })
  mkdirSync(resolve(cloneRoot, '..'), { recursive: true })
  run('git', ['clone', '--local', '--no-hardlinks', '--no-checkout', dshRoot, cloneRoot])
  run('git', ['checkout', '--detach', commit], { cwd: cloneRoot })
  enableInjectedWorkspacePackages(cloneRoot)

  const buildEnv = { ...process.env, CI: 'true', DSH_CLIENT_COMMIT_HASH: commit }
  const inheritedPathKey = Object.keys(buildEnv).find(key => key.toLowerCase() === 'path')
  const inheritedPath = inheritedPathKey ? buildEnv[inheritedPathKey] ?? '' : ''
  // Windows 环境变量不区分大小写，避免 Path/PATH 重复时丢失 runner 工具路径。
  for (const key of Object.keys(buildEnv)) {
    if (key.toLowerCase() === 'path') delete buildEnv[key]
  }
  delete buildEnv.NODE_OPTIONS
  delete buildEnv.NODE_PATH
  buildEnv.PATH = [resolve(nodeDistribution.executable, '..'), inheritedPath].filter(Boolean).join(delimiter)
  const corepackOptions = {
    cwd: cloneRoot,
    env: buildEnv,
    nodeExecutable: nodeDistribution.executable,
    corepackEntry: resolve(nodeDistribution.corepack, 'dist/corepack.js'),
  }
  runCorepack(['pnpm@11.7.0', 'install', '--frozen-lockfile'], corepackOptions)
  const upstreamBuildScript = typeof dshPackage.scripts?.['build:official'] === 'string'
    ? 'build:official'
    : 'build'
  if (typeof dshPackage.scripts?.[upstreamBuildScript] !== 'string') {
    throw new Error('dsh package.json does not declare a supported production build script')
  }
  runCorepack(['pnpm@11.7.0', 'run', upstreamBuildScript], corepackOptions)
  const closure = completeWorkspaceRuntimeClosure(cloneRoot)

  const runtimeRoot = resolve(stage, 'dsh-runtime')
  runCorepack([
    'pnpm@11.7.0',
    '--config.shamefully-hoist=true',
    '--config.virtual-store-dir-max-length=20',
    '--filter',
    '@deepseek-ai/dsh',
    'deploy',
    '--prod',
    runtimeRoot,
  ], corepackOptions)
  sanitizeProductionRuntime({
    runtimeRoot,
    workspacePackageNames: closure.workspacePackageNames,
    forbiddenBuildRoot: cloneRoot,
  })
  injectPluginPayload({ payloadRoot, runtimeRoot })
  const spawnHelper = findSpawnHelper(runtimeRoot, target)
  const nodePtyPackage = findNodePtyPackage(runtimeRoot)
  assertRuntimeShape(runtimeRoot)
  const nodeAbi = run(nodeDistribution.executable, ['-p', 'process.versions.modules'], { capture: true })
  writeFileSync(resolve(stage, 'runtime-manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    app: bootstrap.app,
    dsh: {
      repository: bootstrap.dsh.repository,
      commit,
      commitTime,
      tag,
      version: cliPackage.version,
      nodeEngine,
      credentialsLayout,
      entry: 'dsh-runtime/lib/bin.js',
    },
    native: {
      platform: target.nodePlatform,
      arch: target.nodeArch,
      nodeAbi,
      nodePtyPackage,
      nodePtySpawnHelper: spawnHelper,
    },
    bundledNode: {
      version: pinnedNode,
      archive: nodeDistribution.archive,
      sha256: nodeDistribution.sha256,
    },
    plugins: payload.plugins.map(plugin => ({ id: plugin.id, entry: plugin.entry })),
    pluginDigest: payload.digest,
  }, null, 2)}\n`)
  inventory = collectLicenseInventory(runtimeRoot)
  // 运行时已经收敛到 stage，不让上游临时工作树继续占用安装包构建磁盘。
  rmSync(cloneRoot, { recursive: true, force: true })
}

writeLicenses({
  root,
  stage,
  dshRoot,
  nodeLicense: edition === 'bundled' ? nodeDistribution.license : null,
  inventory,
})
cpSync(resolve(root, 'schemas/dsh-app.plugin.schema.json'), resolve(stage, 'dsh-app.plugin.schema.json'))
cpSync(
  resolve(root, 'schemas/dsh-app.remote-plugins.schema.json'),
  resolve(stage, 'dsh-app.remote-plugins.schema.json'),
)

const tauriResources = resolve(root, 'src-tauri/resources')
mkdirSync(tauriResources, { recursive: true })
for (const entry of readdirSync(tauriResources)) {
  if (entry !== '.gitkeep') rmSync(resolve(tauriResources, entry), { recursive: true, force: true })
}
for (const entry of readdirSync(stage)) {
  cpSync(resolve(stage, entry), resolve(tauriResources, entry), { recursive: true })
}
assertCleanSubmodule(dshRoot)
console.log(`Prepared ${edition} resources for ${triple}: dsh ${cliPackage.version} (${commit.slice(0, 12)})`)
