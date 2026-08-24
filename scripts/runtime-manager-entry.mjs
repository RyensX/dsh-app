import { createHash } from 'node:crypto'
import {
  cpSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { delimiter, resolve } from 'node:path'
import semver from 'semver'
import { parseArgs, requiredArg } from './lib/args.mjs'
import {
  detectDshCredentialsLayout,
  prepareCredentialsProfile,
} from './lib/credentials-profile.mjs'
import {
  assertDshCommit,
  assertDshTag,
  checkDshUpdate,
  createDshBuildWorktree,
  readDshCommitTime,
  readRemoteDshCommitTime,
  removeDshBuildWorktree,
  syncDshSource,
  validateDshRepository,
} from './lib/dsh-git.mjs'
import { run } from './lib/process.mjs'
import { writeNpmCompatibilityShims } from './lib/package-manager-shims.mjs'
import { refreshRuntimePlugins } from './lib/runtime-plugins.mjs'
import {
  readRemotePluginManifest,
  reconcileRemotePlugins as reconcileRemotePluginCatalog,
} from './lib/remote-plugins.mjs'
import {
  completeWorkspaceRuntimeClosure,
  enableInjectedWorkspacePackages,
} from './lib/workspace-runtime.mjs'
import {
  assertRuntimeShape,
  findNodePtyPackage,
  findSpawnHelper,
  materializeProductionRuntime,
  readJson,
  sanitizeProductionRuntime,
} from './lib/runtime.mjs'
import { targetInfo } from './lib/targets.mjs'

const BUILDER_VERSION = 2

const command = process.argv[2]
const args = parseArgs(process.argv.slice(3))

try {
  if (command === 'install') await install()
  else if (command === 'check-update') await checkUpdate()
  else if (command === 'refresh-plugins') await refreshPlugins()
  else if (command === 'reconcile-remote-plugins') await reconcileRemotePlugins()
  else if (command === 'prepare-restore-profile') await prepareRestoreProfile()
  else throw new Error(`unknown runtime-manager command: ${String(command)}`)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
}

async function install() {
  const bootstrapPath = resolve(requiredArg(args, 'bootstrap'))
  const userRuntime = resolve(requiredArg(args, 'user-runtime'))
  const pluginPayload = resolve(requiredArg(args, 'plugin-payload'))
  const corepack = resolve(requiredArg(args, 'corepack'))
  const activation = args.get('activation') ?? 'current'
  if (!['current', 'pending', 'restore'].includes(activation)) {
    throw new Error(`invalid activation: ${activation}`)
  }

  const bootstrap = readJson(bootstrapPath)
  assertBootstrap(bootstrap)
  const requestedTag = args.get('tag')
  const requestedBranch = args.get('branch')
  const commit = args.get('commit')
  const tag = requestedTag ?? null
  const branch = requestedBranch ?? null
  if (!commit) throw new Error('install requires --commit')
  assertDshCommit(commit)
  if (tag !== null) assertDshTag(tag)

  const probe = {
    version: process.version.slice(1),
    abi: String(process.versions.modules ?? ''),
    platform: process.platform,
    arch: process.arch,
  }
  if (!semver.satisfies(probe.version, bootstrap.dsh.nodeEngine)) {
    throw new Error(`Node v${probe.version} does not satisfy ${bootstrap.dsh.nodeEngine}`)
  }
  if (probe.platform !== bootstrap.node.platform || probe.arch !== bootstrap.node.arch) {
    throw new Error(`Node ${probe.platform}/${probe.arch} does not match ${bootstrap.node.platform}/${bootstrap.node.arch}`)
  }

  const runtimeId = createHash('sha256').update(JSON.stringify({
    builder: BUILDER_VERSION,
    commit,
    target: bootstrap.app.target,
    abi: probe.abi,
    pluginDigest: bootstrap.pluginDigest,
  })).digest('hex').slice(0, 32)
  const dshRoot = resolve(userRuntime, 'dsh')
  const installRoot = resolve(dshRoot, 'installs', runtimeId)
  mkdirSync(resolve(dshRoot, 'installs'), { recursive: true })
  mkdirSync(resolve(dshRoot, 'cache'), { recursive: true })
  const releaseLock = acquireInstallLock(dshRoot)

  try {
    rmSync(resolve(dshRoot, 'staging'), { recursive: true, force: true })
    mkdirSync(resolve(dshRoot, 'staging'), { recursive: true })
    if (!validInstall(installRoot, { bootstrap, commit, probe })) {
      progress('Synchronizing DeepSeek Harness source with Git...', 'syncingSource')
      const persistentSourceRoot = syncDshSource({
        repository: bootstrap.dsh.repository,
        commit,
        tag,
        branch,
        destination: resolve(dshRoot, 'source'),
      })
      const commitTime = readDshCommitTime(persistentSourceRoot, commit)
      const sourcePackage = readJson(resolve(persistentSourceRoot, 'package.json'))
      const cliPackage = readJson(resolve(persistentSourceRoot, 'apps/cli/package.json'))
      const credentialsLayout = detectDshCredentialsLayout(persistentSourceRoot)
      if (sourcePackage.engines?.node !== bootstrap.dsh.nodeEngine) {
        throw new Error(`downloaded dsh Node engine changed: ${String(sourcePackage.engines?.node)}`)
      }
      if (tag && cliPackage.version !== tag.replace(/^dsh-v/u, '')) {
        throw new Error(`tag ${tag} contains dsh version ${String(cliPackage.version)}`)
      }

      const temporary = mkdtempSync(resolve(dshRoot, 'staging', `${runtimeId}-`))
      let buildSourceRoot = null
      try {
        buildSourceRoot = createDshBuildWorktree({
          sourceRoot: persistentSourceRoot,
          commit,
          destination: resolve(temporary, 'source'),
        })
        enableInjectedWorkspacePackages(buildSourceRoot)
        preparePnpmShims(corepack, userRuntime)
        const environment = buildEnvironment(userRuntime, commit)
        progress('Installing frozen dsh dependencies...', 'installingDependencies')
        corepackPnpm(corepack, ['install', '--frozen-lockfile'], buildSourceRoot, environment)

        progress('Compiling DeepSeek Harness...', 'compiling')
        const upstreamBuildScript = typeof sourcePackage.scripts?.['build:official'] === 'string'
          ? 'build:official'
          : 'build'
        if (typeof sourcePackage.scripts?.[upstreamBuildScript] !== 'string') {
          throw new Error('downloaded dsh does not declare a supported production build script')
        }
        corepackPnpm(corepack, ['run', upstreamBuildScript], buildSourceRoot, environment)
        const closure = completeWorkspaceRuntimeClosure(buildSourceRoot)

        progress('Assembling the production runtime...', 'assembling')
        const stagedInstall = resolve(temporary, 'install')
        const runtimeRoot = resolve(stagedInstall, 'dsh-runtime')
        const deployedRuntimeRoot = resolve(temporary, 'deploy', 'dsh-runtime')
        corepackPnpm(corepack, [
          '--config.shamefully-hoist=true',
          '--config.virtual-store-dir-max-length=50',
          '--filter',
          '@deepseek-ai/dsh',
          'deploy',
          '--prod',
          deployedRuntimeRoot,
        ], buildSourceRoot, environment)
        sanitizeProductionRuntime({
          runtimeRoot: deployedRuntimeRoot,
          workspacePackageNames: closure.workspacePackageNames,
          forbiddenBuildRoot: buildSourceRoot,
        })
        materializeProductionRuntime(deployedRuntimeRoot, runtimeRoot)
        const payload = injectPayload(pluginPayload, runtimeRoot)
        const target = { nodePlatform: probe.platform, nodeArch: probe.arch }
        const spawnHelper = findSpawnHelper(runtimeRoot, target)
        const nodePtyPackage = findNodePtyPackage(runtimeRoot)
        assertRuntimeShape(runtimeRoot)

        const manifest = {
          schemaVersion: 1,
          builderVersion: BUILDER_VERSION,
          app: {
            version: bootstrap.app.version,
            edition: 'managed',
            target: bootstrap.app.target,
          },
          dsh: {
            repository: bootstrap.dsh.repository,
            commit,
            commitTime,
            tag,
            version: cliPackage.version,
            nodeEngine: sourcePackage.engines.node,
            credentialsLayout,
            entry: 'dsh-runtime/lib/bin.js',
          },
          native: {
            platform: probe.platform,
            arch: probe.arch,
            nodeAbi: probe.abi,
            nodePtyPackage,
            nodePtySpawnHelper: spawnHelper,
          },
          bundledNode: null,
          plugins: payload.plugins,
          pluginDigest: payload.digest,
        }
        writeFileSync(resolve(stagedInstall, 'runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
        cpSync(resolve(buildSourceRoot, 'LICENSE'), resolve(stagedInstall, 'deepseek-harness-MIT.txt'))

        progress('Validating the installed runtime...', 'validating')
        if (!validInstall(stagedInstall, { bootstrap, commit, probe })) {
          throw new Error('the staged dsh runtime failed its final manifest validation')
        }
        rmSync(installRoot, { recursive: true, force: true })
        renameSync(stagedInstall, installRoot)
      } finally {
        try {
          if (buildSourceRoot !== null) {
            removeDshBuildWorktree({ sourceRoot: persistentSourceRoot, destination: buildSourceRoot })
          }
        } finally {
          rmSync(temporary, { recursive: true, force: true })
        }
      }
    }

    const pointer = { schemaVersion: 1, runtimeId, commit, tag }
    if (activation === 'current') {
      atomicJson(resolve(dshRoot, 'current.json'), pointer)
    } else if (activation === 'pending') {
      atomicJson(resolve(userRuntime, 'pending-action.json'), {
        schemaVersion: 1,
        action: 'activateManaged',
        ...pointer,
      })
    } else {
      atomicJson(resolve(userRuntime, 'pending-action.json'), {
        schemaVersion: 1,
        action: 'restoreManaged',
        ...pointer,
      })
    }
    result({ runtimeId, commit, tag, activation })
  } finally {
    releaseLock()
  }
}

async function checkUpdate() {
  const bootstrap = readJson(resolve(requiredArg(args, 'bootstrap')))
  assertBootstrap(bootstrap)
  const update = checkDshUpdate(
    bootstrap.dsh.repository,
    requiredArg(args, 'current-commit'),
    args.get('current-tag') ?? null,
    args.get('channel') ?? 'stable',
  )
  result({
    ...update,
    latestCommitTime: readRemoteDshCommitTime({
      repository: bootstrap.dsh.repository,
      commit: update.latestCommit,
      tag: update.latestTag,
      branch: update.latestBranch,
    }),
  })
}

async function refreshPlugins() {
  const bootstrap = readJson(resolve(requiredArg(args, 'bootstrap')))
  assertBootstrap(bootstrap)
  const userRuntime = resolve(requiredArg(args, 'user-runtime'))
  const pluginPayload = resolve(requiredArg(args, 'plugin-payload'))
  const runtimeId = requiredArg(args, 'runtime-id')
  if (!/^[a-f0-9]{32}$/u.test(runtimeId)) throw new Error(`invalid runtime id: ${runtimeId}`)

  const dshRoot = resolve(userRuntime, 'dsh')
  const installRoot = resolve(dshRoot, 'installs', runtimeId)
  mkdirSync(dshRoot, { recursive: true })
  const releaseLock = acquireInstallLock(dshRoot)
  try {
    const refreshed = refreshRuntimePlugins({ installRoot, payloadRoot: pluginPayload, bootstrap })
    result({ runtimeId, ...refreshed })
  } finally {
    releaseLock()
  }
}

async function reconcileRemotePlugins() {
  const manifestPath = resolve(requiredArg(args, 'manifest'))
  const profileHome = resolve(requiredArg(args, 'profile'))
  const statePath = resolve(requiredArg(args, 'state'))
  const runtimeEntry = resolve(requiredArg(args, 'runtime-entry'))
  const corepack = resolve(requiredArg(args, 'corepack'))
  const userRuntime = resolve(requiredArg(args, 'user-runtime'))
  const targetTriple = requiredArg(args, 'target')
  const edition = requiredArg(args, 'edition')
  const dshCommit = requiredArg(args, 'dsh-commit')
  if (!['bundled', 'lite'].includes(edition)) throw new Error(`invalid edition: ${edition}`)
  if (!existsSync(runtimeEntry)) throw new Error(`remote plugin dsh entry is missing: ${runtimeEntry}`)

  const manifest = readRemotePluginManifest(manifestPath)
  const platform = targetInfo(targetTriple).appTarget
  mkdirSync(profileHome, { recursive: true })
  const environment = {
    ...buildEnvironment(userRuntime, dshCommit),
    DSH_HOME: profileHome,
  }
  let initialized = false
  const invokePluginCommand = pluginArgs => run(process.execPath, [
    runtimeEntry,
    'plugin',
    '--profile', 'web',
    ...pluginArgs,
  ], {
    cwd: profileHome,
    env: environment,
    capture: true,
  })

  const dshRoot = resolve(userRuntime, 'dsh')
  mkdirSync(dshRoot, { recursive: true })
  const releaseLock = acquireInstallLock(dshRoot)
  try {
    const report = reconcileRemotePluginCatalog({
      manifest,
      target: platform,
      edition,
      profileHome,
      statePath,
      initializeProfile() {
        if (initialized) return
        preparePnpmShims(corepack, userRuntime)
        progress('Initializing the dsh web profile for remote plugins...', 'initializingRemotePlugins')
        invokePluginCommand(['root'])
        initialized = true
      },
      removePlugin(plugin) {
        progress(`Repairing remote plugin ${plugin.name}...`, 'installingRemotePlugin')
        invokePluginCommand(['remove', plugin.name])
      },
      installPlugin(plugin) {
        progress(`Installing remote plugin ${plugin.name}...`, 'installingRemotePlugin')
        invokePluginCommand(['add', plugin.source])
      },
    })
    result({ remotePlugins: report })
  } finally {
    releaseLock()
  }
}

async function prepareRestoreProfile() {
  const profileRoot = resolve(requiredArg(args, 'profile'))
  const credentialsLayout = requiredArg(args, 'credentials-layout')
  const prepared = prepareCredentialsProfile({
    profileRoot,
    targetLayout: credentialsLayout,
  })
  result({ credentialsLayout, changed: prepared.changed })
}

function buildEnvironment(userRuntime, commit) {
  const pnpmHome = resolve(userRuntime, 'dsh/cache/pnpm-home')
  const environment = {
    ...process.env,
    CI: 'true',
    DSH_CLIENT_COMMIT_HASH: commit,
    COREPACK_HOME: resolve(userRuntime, 'dsh/cache/corepack'),
    PNPM_HOME: pnpmHome,
    npm_config_cache: resolve(userRuntime, 'dsh/cache/npm'),
    pnpm_config_store_dir: resolve(userRuntime, 'dsh/cache/pnpm-store'),
    pnpm_config_network_concurrency: '16',
    pnpm_config_fetch_timeout: '300000',
    pnpm_config_fetch_retries: '4',
  }
  environment.PATH = [
    pnpmHome,
    resolve(process.execPath, '..'),
    environment.PATH ?? '',
  ].join(delimiter)
  delete environment.NODE_OPTIONS
  delete environment.NODE_PATH
  return environment
}

function preparePnpmShims(corepack, userRuntime) {
  const pnpmHome = resolve(userRuntime, 'dsh/cache/pnpm-home')
  mkdirSync(pnpmHome, { recursive: true })
  progress('Preparing the pinned pnpm toolchain...', 'preparingToolchain')
  run(process.execPath, [
    corepack,
    'enable',
    '--install-directory', pnpmHome,
    'pnpm',
  ])
  writeNpmCompatibilityShims({
    directory: pnpmHome,
    nodeExecutable: process.execPath,
    corepack,
  })
}

function corepackPnpm(corepack, pnpmArgs, cwd, env) {
  run(process.execPath, [corepack, 'pnpm@11.7.0', ...pnpmArgs], { cwd, env })
}

function injectPayload(payloadRoot, runtimeRoot) {
  const payload = readJson(resolve(payloadRoot, 'payload.json'))
  const manifestPath = resolve(runtimeRoot, 'package.json')
  const manifest = readJson(manifestPath)
  manifest.dependencies ??= {}
  mkdirSync(resolve(runtimeRoot, 'plugins'), { recursive: true })
  cpSync(resolve(payloadRoot, 'plugins/index.json'), resolve(runtimeRoot, 'plugins/index.json'))
  for (const plugin of payload.plugins) {
    const source = resolve(payloadRoot, 'node_modules', plugin.id)
    const destination = resolve(runtimeRoot, 'node_modules', plugin.id)
    if (existsSync(destination)) throw new Error(`app plugin conflicts with dsh dependency: ${plugin.id}`)
    cpSync(source, destination, { recursive: true, errorOnExist: true, force: false })
    manifest.dependencies[plugin.id] = '0.0.0'
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return payload
}

function validInstall(root, { bootstrap, commit, probe }) {
  try {
    const manifest = readJson(resolve(root, 'runtime-manifest.json'))
    return manifest.schemaVersion === 1
      && manifest.builderVersion === BUILDER_VERSION
      && manifest.app?.edition === 'managed'
      && manifest.app?.target === bootstrap.app.target
      && manifest.dsh?.commit === commit
      && typeof manifest.dsh?.commitTime === 'string'
      && manifest.native?.platform === probe.platform
      && manifest.native?.arch === probe.arch
      && manifest.native?.nodeAbi === probe.abi
      && manifest.pluginDigest === bootstrap.pluginDigest
      && existsSync(resolve(root, manifest.dsh.entry))
  } catch {
    return false
  }
}

function assertBootstrap(value) {
  if (value?.schemaVersion !== 1 || value?.app?.target === undefined || value?.dsh?.nodeEngine === undefined) {
    throw new Error('bootstrap manifest is invalid')
  }
  validateDshRepository(value.dsh.repository)
  if (value.node?.platform !== process.platform || value.node?.arch !== process.arch) {
    throw new Error(`bootstrap target ${String(value.node?.platform)}/${String(value.node?.arch)} does not match this host`)
  }
}

function atomicJson(path, value) {
  mkdirSync(resolve(path, '..'), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
  const backup = `${path}.previous-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
  let movedPrevious = false
  try {
    if (existsSync(path)) {
      rmSync(backup, { force: true })
      renameSync(path, backup)
      movedPrevious = true
    }
    renameSync(temporary, path)
    rmSync(backup, { force: true })
  } catch (error) {
    rmSync(temporary, { force: true })
    if (movedPrevious && !existsSync(path) && existsSync(backup)) renameSync(backup, path)
    throw error
  }
}

function acquireInstallLock(dshRoot) {
  const path = resolve(dshRoot, 'install.lock')
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(path, 'wx', 0o600)
      writeFileSync(descriptor, `${JSON.stringify({ schemaVersion: 1, pid: process.pid })}\n`)
      closeSync(descriptor)
      return () => { rmSync(path, { force: true }) }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      let stale = false
      try {
        const state = JSON.parse(readFileSync(path, 'utf8'))
        if (!Number.isInteger(state.pid) || state.pid < 1) stale = true
        else {
          try { process.kill(state.pid, 0) } catch { stale = true }
        }
      } catch {
        stale = true
      }
      if (!stale) throw new Error('another dsh installation or update is still running')
      rmSync(path, { force: true })
    }
  }
  throw new Error('could not acquire the managed dsh install lock')
}

function progress(message, stage) {
  process.stdout.write(`${JSON.stringify({ type: 'progress', stage, message })}\n`)
}

function result(value) {
  process.stdout.write(`${JSON.stringify({ type: 'result', ...value })}\n`)
}
