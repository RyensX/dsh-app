import {
  constants as fsConstants,
  cpSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { run } from './process.mjs'

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function assertCleanSubmodule(dshRoot) {
  const repositoryRoot = run('git', ['rev-parse', '--show-toplevel'], { cwd: dshRoot, capture: true })
  if (realpathSync(repositoryRoot) !== realpathSync(dshRoot)) {
    throw new Error('dsh must be checked out as its own Git submodule')
  }
  const output = run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: dshRoot, capture: true })
  if (output) throw new Error(`dsh submodule is not clean:\n${output}`)
}

export function verifySymlinkClosure(root) {
  const absoluteRoot = realpathSync(root)
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) {
        const target = realpathSync(path)
        if (target !== absoluteRoot && !target.startsWith(`${absoluteRoot}${sep}`)) {
          throw new Error(`external runtime symlink: ${path} -> ${target}`)
        }
      } else if (stat.isDirectory()) {
        visit(path)
      }
    }
  }
  visit(root)
}

function regularFileIdentities(root) {
  const identities = new Map()
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        visit(path)
      } else if (entry.isFile()) {
        const stat = statSync(path, { bigint: true })
        // ino 为 0 的平台无法提供稳定文件身份；复制仍由 copyFile 语义保证独立。
        if (stat.ino !== 0n) identities.set(`${stat.dev}:${stat.ino}`, path)
      }
    }
  }
  visit(root)
  return identities
}

export function assertNoSharedRegularFiles(sourceRoot, destinationRoot) {
  const sourceFiles = regularFileIdentities(sourceRoot)
  let checkedFiles = 0
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        visit(path)
      } else if (entry.isFile()) {
        const stat = statSync(path, { bigint: true })
        if (stat.ino === 0n) continue
        checkedFiles += 1
        const sharedWith = sourceFiles.get(`${stat.dev}:${stat.ino}`)
        if (sharedWith) {
          throw new Error(`published runtime file still shares storage with build output: ${path} -> ${sharedWith}`)
        }
      }
    }
  }
  visit(destinationRoot)
  return { sourceFiles: sourceFiles.size, checkedFiles }
}

export function materializeProductionRuntime(sourceRoot, destinationRoot) {
  if (existsSync(destinationRoot)) {
    throw new Error(`isolated runtime destination already exists: ${destinationRoot}`)
  }
  mkdirSync(resolve(destinationRoot, '..'), { recursive: true })
  // pnpm deploy 可能保留 workspace 硬链接；发布前用独立文件树切断与构建目录的联系。
  cpSync(sourceRoot, destinationRoot, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
    verbatimSymlinks: true,
    mode: fsConstants.COPYFILE_FICLONE,
  })
  return assertNoSharedRegularFiles(sourceRoot, destinationRoot)
}

export function findSpawnHelper(runtimeRoot, target) {
  if (target.nodePlatform !== 'darwin') return null
  const candidates = []
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.name === 'spawn-helper' && path.includes(`darwin-${target.nodeArch}`)) candidates.push(path)
    }
  }
  visit(runtimeRoot)
  if (candidates.length === 0) throw new Error(`node-pty spawn-helper not found for darwin-${target.nodeArch}`)
  const selected = candidates.sort((a, b) => a.length - b.length)[0]
  run('chmod', ['755', selected])
  return relative(runtimeRoot, selected).split(sep).join('/')
}

export function findNodePtyPackage(runtimeRoot) {
  const candidates = []
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = resolve(directory, entry.name)
      const manifest = resolve(path, 'package.json')
      if (entry.name === 'node-pty' && existsSync(manifest)) {
        try {
          if (readJson(manifest).name === 'node-pty') candidates.push(path)
        } catch {
          // Keep walking; malformed metadata cannot be selected as the native package.
        }
      }
      visit(path)
    }
  }
  visit(runtimeRoot)
  if (candidates.length === 0) throw new Error('node-pty package is missing from the production runtime')
  return relative(runtimeRoot, candidates.sort((a, b) => a.length - b.length)[0]).split(sep).join('/')
}

export function collectLicenseInventory(runtimeRoot) {
  const packages = new Map()
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = resolve(directory, entry.name)
      const manifest = resolve(path, 'package.json')
      if (existsSync(manifest)) {
        try {
          const value = readJson(manifest)
          if (typeof value.name === 'string' && typeof value.version === 'string') {
            packages.set(`${value.name}@${value.version}`, {
              name: value.name,
              version: value.version,
              license: typeof value.license === 'string' ? value.license : 'UNKNOWN',
            })
          }
        } catch {
          // A dependency may expose a non-JSON package metadata file; it is not executable input.
        }
      }
      visit(path)
    }
  }
  visit(resolve(runtimeRoot, 'node_modules'))
  return [...packages.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`))
}

export function writeLicenses({ root, stage, dshRoot, nodeLicense, inventory }) {
  const licenses = resolve(stage, 'licenses')
  mkdirSync(licenses, { recursive: true })
  copyFileSync(resolve(root, 'LICENSE'), resolve(licenses, 'DSH-App-AGPL-3.0.txt'))
  copyFileSync(resolve(dshRoot, 'LICENSE'), resolve(licenses, 'deepseek-harness-MIT.txt'))
  if (nodeLicense) copyFileSync(nodeLicense, resolve(licenses, 'Node.js-LICENSE.txt'))
  copyFileSync(resolve(root, 'THIRD_PARTY_NOTICES.md'), resolve(licenses, 'DSH-App-THIRD-PARTY-NOTICES.md'))
  writeFileSync(resolve(licenses, 'THIRD_PARTY-LICENSES.json'), `${JSON.stringify({ schemaVersion: 1, packages: inventory }, null, 2)}\n`)
}

function packagePath(runtimeRoot, packageName) {
  return resolve(runtimeRoot, 'node_modules', ...packageName.split('/'))
}

function removeSourceMetadata(manifest) {
  let changed = false
  if (Array.isArray(manifest.files)) {
    const files = manifest.files.filter(entry => {
      if (typeof entry !== 'string') return true
      const normalized = entry.replace(/^!/u, '').replace(/^\.\//u, '')
      return normalized !== 'src' && !normalized.startsWith('src/')
    })
    if (files.length !== manifest.files.length) {
      manifest.files = files
      changed = true
    }
  }
  if (manifest.exports && typeof manifest.exports === 'object' && !Array.isArray(manifest.exports)) {
    for (const key of Object.keys(manifest.exports)) {
      if (key === './src' || key.startsWith('./src/')) {
        delete manifest.exports[key]
        changed = true
      }
    }
  }
  return changed
}

function sanitizeDeployManifest(runtimeRoot, forbiddenBuildRoot) {
  const manifestPath = resolve(runtimeRoot, 'package.json')
  const manifest = readJson(manifestPath)
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const dependencies = manifest[section]
    if (!dependencies || typeof dependencies !== 'object') continue
    for (const [name, value] of Object.entries(dependencies)) {
      if (typeof value !== 'string' || (!value.includes('file:') && !value.includes(forbiddenBuildRoot))) continue
      const installed = packagePath(runtimeRoot, name)
      if (!existsSync(installed)) {
        throw new Error(`cannot sanitize unresolved deployed dependency ${name}`)
      }
      const deployed = readJson(resolve(realpathSync(installed), 'package.json'))
      if (typeof deployed.version !== 'string') throw new Error(`deployed dependency has no version: ${name}`)
      dependencies[name] = deployed.version
    }
  }
  const output = `${JSON.stringify(manifest, null, 2)}\n`
  if (output.includes(forbiddenBuildRoot)) {
    throw new Error(`temporary build path leaked into deployed package.json: ${forbiddenBuildRoot}`)
  }
  writeFileSync(manifestPath, output)
}

function sanitizeGeneratedBuildMarkers(packageRoot, forbiddenBuildRoot) {
  let markers = 0
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        visit(path)
        continue
      }
      if (!entry.isFile() || !/\.(?:c|m)?js$/u.test(entry.name)) continue
      const contents = readFileSync(path, 'utf8')
      if (!contents.includes(forbiddenBuildRoot)) continue
      for (const line of contents.split('\n')) {
        if (line.includes(forbiddenBuildRoot) && !/^\s*\/\/#region \\0dsh-(?:inline-)?css:/u.test(line)) {
          throw new Error(`temporary build path occurs outside a generated CSS region marker: ${path}`)
        }
      }
      markers += contents.split(forbiddenBuildRoot).length - 1
      writeFileSync(path, contents.replaceAll(forbiddenBuildRoot, 'dsh-source'))
    }
  }
  const lib = resolve(packageRoot, 'lib')
  if (existsSync(lib)) visit(lib)
  return markers
}

export function assertNoBuildPathLeak(root, forbiddenBuildRoot) {
  const needles = [
    Buffer.from(forbiddenBuildRoot),
    Buffer.from(forbiddenBuildRoot.split(sep).join('+')),
  ]
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (needles.some(needle => Buffer.from(path).includes(needle))) {
        throw new Error(`temporary build path leaked into runtime path: ${path}`)
      }
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) {
        const contents = readFileSync(path)
        if (needles.some(needle => contents.includes(needle))) {
          throw new Error(`temporary build path leaked into runtime file: ${path}`)
        }
      }
    }
  }
  visit(root)
}

export function sanitizeProductionRuntime({ runtimeRoot, workspacePackageNames, forbiddenBuildRoot }) {
  let packages = 0
  let sourceDirectories = 0
  let buildPathMarkers = 0
  const visited = new Set()
  for (const packageName of workspacePackageNames) {
    const installed = packagePath(runtimeRoot, packageName)
    if (!existsSync(installed)) continue
    const packageRoot = realpathSync(installed)
    if (visited.has(packageRoot)) continue
    visited.add(packageRoot)
    const manifestPath = resolve(packageRoot, 'package.json')
    const manifest = readJson(manifestPath)
    if (manifest.name !== packageName) {
      throw new Error(`hoisted package mismatch: expected ${packageName}, found ${String(manifest.name)}`)
    }
    const source = resolve(packageRoot, 'src')
    if (existsSync(source)) {
      rmSync(source, { recursive: true, force: true })
      sourceDirectories += 1
    }
    if (removeSourceMetadata(manifest)) {
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    }
    buildPathMarkers += sanitizeGeneratedBuildMarkers(packageRoot, forbiddenBuildRoot)
    packages += 1
  }
  sanitizeDeployManifest(runtimeRoot, forbiddenBuildRoot)
  for (const metadata of [
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'node_modules/.modules.yaml',
    'node_modules/.pnpm/lock.yaml',
    'node_modules/.pnpm-workspace-state-v1.json',
  ]) {
    rmSync(resolve(runtimeRoot, metadata), { force: true })
  }
  assertNoBuildPathLeak(runtimeRoot, forbiddenBuildRoot)
  return { packages, sourceDirectories, buildPathMarkers }
}

function assertNoUpstreamSources(runtimeRoot) {
  const virtualStore = resolve(runtimeRoot, 'node_modules/.pnpm')
  if (!existsSync(virtualStore)) throw new Error('pnpm virtual store is missing from the production runtime')
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = resolve(directory, entry.name)
      const relativePath = relative(virtualStore, path).split(sep).join('/')
      if (/^[^/]+\/node_modules\/@deepseek-ai\/[^/]+\/src$/u.test(relativePath)) {
        throw new Error(`upstream source directory leaked into runtime: ${relativePath}`)
      }
      visit(path)
    }
  }
  visit(virtualStore)
}

export function assertRuntimeShape(runtimeRoot) {
  const entry = resolve(runtimeRoot, 'lib/bin.js')
  if (!existsSync(entry)) throw new Error(`dsh runtime entry missing: ${entry}`)
  for (const forbidden of ['.git', 'apps', 'packages', 'vendor', 'website']) {
    if (existsSync(resolve(runtimeRoot, forbidden))) throw new Error(`source directory leaked into runtime: ${forbidden}`)
  }
  for (const metadata of [
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'node_modules/.modules.yaml',
    'node_modules/.pnpm/lock.yaml',
    'node_modules/.pnpm-workspace-state-v1.json',
  ]) {
    if (existsSync(resolve(runtimeRoot, metadata))) throw new Error(`build metadata leaked into runtime: ${metadata}`)
  }
  if (readFileSync(resolve(runtimeRoot, 'package.json'), 'utf8').includes('file:')) {
    throw new Error('temporary file dependency leaked into runtime package.json')
  }
  assertNoUpstreamSources(runtimeRoot)
  verifySymlinkClosure(runtimeRoot)
}
