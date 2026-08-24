import { globSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { parseDocument } from 'yaml'

function readYamlDocument(path) {
  const document = parseDocument(readFileSync(path, 'utf8'))
  if (document.errors.length > 0) {
    throw new Error(`invalid YAML at ${path}: ${document.errors.map(error => error.message).join('; ')}`)
  }
  return document
}

function workspacePackages(cloneRoot) {
  const paths = globSync([
    'apps/*/package.json',
    'native/landlock-run/package.json',
    'native/landlock-run/packages/*/package.json',
    'packages/*/*/package.json',
    'vendor/*/package.json',
  ], { cwd: cloneRoot }).sort()
  const packages = new Map()
  for (const relativePath of paths) {
    const path = resolve(cloneRoot, relativePath)
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof manifest.name === 'string') packages.set(manifest.name, { path, manifest })
  }
  return packages
}

function normalizePath(path) {
  return path.split(sep).join('/')
}

function externalLockState(lockfile) {
  const value = lockfile.toJS()
  return {
    packages: value.packages ?? {},
    overrides: value.overrides ?? {},
    patchedDependencies: value.patchedDependencies ?? {},
  }
}

export function enableInjectedWorkspacePackages(cloneRoot) {
  const workspacePath = resolve(cloneRoot, 'pnpm-workspace.yaml')
  const lockfilePath = resolve(cloneRoot, 'pnpm-lock.yaml')
  const workspace = readYamlDocument(workspacePath)
  const lockfile = readYamlDocument(lockfilePath)
  const externalBefore = externalLockState(lockfile)
  if (!lockfile.has('settings')) lockfile.set('settings', {})
  lockfile.setIn(['settings', 'injectWorkspacePackages'], true)

  workspace.set('injectWorkspacePackages', true)
  workspace.set('syncInjectedDepsAfterScripts', ['build'])
  if (!workspace.has('allowBuilds')) workspace.set('allowBuilds', {})
  const subprocessPackage = resolve(cloneRoot, 'packages/subprocess/subprocess-local')
  const subprocessLocator = `@deepseek-ai/dsh-subprocess-local@${pathToFileURL(subprocessPackage).href}`
  workspace.setIn(['allowBuilds', subprocessLocator], true)

  if (!isDeepStrictEqual(externalBefore, externalLockState(lockfile))) {
    throw new Error('workspace closure preparation changed external lock resolution')
  }
  writeFileSync(workspacePath, workspace.toString())
  writeFileSync(lockfilePath, lockfile.toString())

  return { subprocessLocator }
}

export function completeWorkspaceRuntimeClosure(cloneRoot, deployPackage = 'apps/cli') {
  const workspacePath = resolve(cloneRoot, 'pnpm-workspace.yaml')
  const lockfilePath = resolve(cloneRoot, 'pnpm-lock.yaml')
  const deployManifestPath = resolve(cloneRoot, deployPackage, 'package.json')
  const workspace = readYamlDocument(workspacePath)
  const lockfile = readYamlDocument(lockfilePath)
  const externalBefore = externalLockState(lockfile)
  const packages = workspacePackages(cloneRoot)
  const deployManifest = JSON.parse(readFileSync(deployManifestPath, 'utf8'))
  const rootDependencies = new Set(Object.keys(deployManifest.dependencies ?? {}))
  const visited = new Set()
  const queue = [...rootDependencies].filter(name => packages.has(name)).sort()
  const addedPeers = new Set()

  for (let index = 0; index < queue.length; index += 1) {
    const name = queue[index]
    if (visited.has(name)) continue
    visited.add(name)
    const current = packages.get(name)?.manifest
    if (!current) continue

    const peerMeta = current.peerDependenciesMeta ?? {}
    for (const peer of Object.keys(current.peerDependencies ?? {}).sort()) {
      if (!packages.has(peer) || peerMeta[peer]?.optional === true) continue
      if (!rootDependencies.has(peer)) {
        rootDependencies.add(peer)
        addedPeers.add(peer)
      }
      if (!visited.has(peer)) queue.push(peer)
    }

    const transitive = { ...current.dependencies, ...current.optionalDependencies }
    for (const dependency of Object.keys(transitive).sort()) {
      if (packages.has(dependency) && !visited.has(dependency)) queue.push(dependency)
    }
  }

  const dependencies = { ...deployManifest.dependencies }
  for (const peer of addedPeers) dependencies[peer] = 'workspace:^'
  deployManifest.dependencies = Object.fromEntries(
    Object.entries(dependencies).sort(([left], [right]) => left.localeCompare(right)),
  )
  delete deployManifest.devDependencies
  writeFileSync(deployManifestPath, `${JSON.stringify(deployManifest, null, 2)}\n`)

  lockfile.deleteIn(['importers', deployPackage, 'devDependencies'])

  for (const peer of [...addedPeers].sort()) {
    const packagePath = packages.get(peer)?.path
    if (!packagePath) throw new Error(`workspace peer disappeared while preparing lock importer: ${peer}`)
    const link = normalizePath(relative(dirname(deployManifestPath), dirname(packagePath)))
    const override = workspace.getIn(['overrides', peer])
    const specifier = typeof override === 'string' && override.startsWith('link:')
      ? `link:${link}`
      : 'workspace:^'
    lockfile.setIn(['importers', deployPackage, 'dependencies', peer], {
      specifier,
      version: `link:${link}`,
    })
  }

  if (!isDeepStrictEqual(externalBefore, externalLockState(lockfile))) {
    throw new Error('workspace closure preparation changed external lock resolution')
  }
  writeFileSync(lockfilePath, lockfile.toString())

  return {
    addedPeers: [...addedPeers].sort(),
    reachablePackages: visited.size,
    workspacePackageNames: [...visited].sort(),
  }
}
