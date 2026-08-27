import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { delimiter, resolve } from 'node:path'
import { parseArgs, requiredArg } from './lib/args.mjs'
import { runCorepack } from './lib/corepack.mjs'
import { installerFilename } from './lib/installers.mjs'
import { run } from './lib/process.mjs'
import { parseFormal, readSigningOverlay, validateFormalSigning } from './lib/signing.mjs'
import { targetInfo } from './lib/targets.mjs'

const root = resolve(import.meta.dirname, '..')
const args = parseArgs(process.argv.slice(2))
const edition = requiredArg(args, 'edition')
const triple = requiredArg(args, 'target')
if (!['bundled', 'lite'].includes(edition)) throw new Error(`invalid edition: ${edition}`)
const target = targetInfo(triple)
const version = String(JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version)
const formal = parseFormal(args.get('formal'))
const signingConfig = args.get('signing-config')
const signingOverlay = readSigningOverlay(signingConfig)
// 提前生成并校验最终文件名，避免无效的 pre-release 参数在耗时构建结束后才报错。
const publishedFilename = installerFilename({
  edition,
  version,
  platform: target.appTarget,
  arch: target.nodeArch,
  suffix: args.get('artifact-suffix'),
  commit: args.get('artifact-commit'),
})
validateFormalSigning({
  formal,
  appTarget: target.appTarget,
  environment: process.env,
  signingOverlay,
})

run(process.execPath, [
  'scripts/prepare-resources.mjs',
  '--edition', edition,
  '--target', triple,
], { cwd: root })
run(process.execPath, ['scripts/verify-resources.mjs'], { cwd: root })
if (edition === 'bundled') {
  run(process.execPath, ['scripts/test-runtime-integration.mjs'], { cwd: root })
}

const config = JSON.parse(readFileSync(resolve(root, `src-tauri/tauri.${edition}.conf.json`), 'utf8'))
if (signingOverlay) deepMerge(config, signingOverlay)
const resourcesRoot = resolve(root, 'src-tauri/resources')
const compactResourcesRoot = resolve(root, '.build/r')
// Tauri/NSIS 使用资源的绝对源路径，统一缩短打包输入路径以避免 Windows MAX_PATH。
rmSync(compactResourcesRoot, { recursive: true, force: true })
renameSync(resourcesRoot, compactResourcesRoot)
config.bundle ??= {}
config.bundle.resources = { [compactResourcesRoot]: 'resources' }
if (target.appTarget === 'macos' && !formal) {
  // 无 Apple 证书的 pre-release 使用完整 ad-hoc 签名，避免 Gatekeeper 误报应用已损坏。
  config.bundle.macOS ??= {}
  config.bundle.macOS.signingIdentity = '-'
}
const bundles = target.appTarget === 'macos' ? 'dmg' : 'nsis'
const bundleRoot = resolve(root, 'src-tauri/target', triple, 'release/bundle', bundles)
// Tauri 的 bundle 目录只是本次构建的临时输入，避免误选到上一 edition 的旧安装器。
rmSync(bundleRoot, { recursive: true, force: true })
const tauriArgs = [
  'exec', 'tauri', 'build',
  '--features', edition,
  '--target', triple,
  '--bundles', bundles,
  '--config', JSON.stringify(config),
]
const macosCiBuild = target.appTarget === 'macos' && process.env.CI === 'true'
if (macosCiBuild && !formal) tauriArgs.push('--verbose')
if (macosCiBuild) run('df', ['-h', '.'], { cwd: root })
const tauriEnvironment = { ...process.env, CI: 'true' }
if (macosCiBuild) {
  // create-dmg 遇到 DiskArbitration 超时时，由 shim 在常规 detach 失败后强制卸载。
  tauriEnvironment.PATH = [
    resolve(root, 'scripts/ci/macos'),
    tauriEnvironment.PATH ?? '',
  ].filter(Boolean).join(delimiter)
}
try {
  runCorepack(['pnpm@11.7.0', ...tauriArgs], {
    cwd: root,
    env: tauriEnvironment,
  })
} finally {
  renameSync(compactResourcesRoot, resourcesRoot)
}
run(process.execPath, [
  'scripts/verify-frontend.mjs',
  '--edition', edition,
  '--path', resolve(root, 'dist', edition),
], { cwd: root })

const builtArtifact = verifyBuiltArtifact()
const publishedArtifact = publishInstaller(builtArtifact)
console.log(`Installer ready: ${publishedArtifact}`)

function verifyBuiltArtifact() {
  if (target.appTarget === 'macos') {
    const image = newestFile(bundleRoot, entry => entry.toLowerCase().endsWith('.dmg'))
    if (!image) throw new Error(`built DMG is missing for ${edition}`)
    mkdirSync(resolve(root, '.build'), { recursive: true })
    const mounted = mkdtempSync(resolve(root, '.build/dmg-'))
    let attached = false
    try {
      run('hdiutil', ['attach', image, '-mountpoint', mounted, '-nobrowse', '-readonly'])
      attached = true
      const application = resolve(mounted, 'DSH App.app')
      if (!existsSync(application)) throw new Error(`mounted DMG has no DSH App.app: ${image}`)
      run(process.execPath, [
        'scripts/verify-artifact.mjs',
        '--edition', edition,
        '--path', application,
      ], { cwd: root })
      run('codesign', ['--verify', '--deep', '--strict', '--verbose=4', application])
    } finally {
      if (attached) run('hdiutil', ['detach', mounted])
      rmSync(mounted, { recursive: true, force: true })
    }
    return image
  }

  const installer = newestFile(bundleRoot, entry => entry.toLowerCase().endsWith('.exe'))
  if (!installer) throw new Error(`built NSIS installer is missing for ${edition}`)
  mkdirSync(resolve(root, '.build'), { recursive: true })
  const unpacked = mkdtempSync(resolve(root, '.build/artifact-'))
  try {
    run('7z', ['x', installer, `-o${unpacked}`, '-y'])
    for (const archive of findFiles(unpacked, path => path.toLowerCase().endsWith('.7z'))) {
      run('7z', ['x', archive, `-o${unpacked}`, '-y'])
    }
    run(process.execPath, [
      'scripts/verify-artifact.mjs',
      '--edition', edition,
      '--path', unpacked,
    ], { cwd: root })
  } finally {
    rmSync(unpacked, { recursive: true, force: true })
  }
  return installer
}

function publishInstaller(builtArtifact) {
  const installersRoot = resolve(root, '.build/installers')
  mkdirSync(installersRoot, { recursive: true })
  // 旧实现按 target 建子目录；新契约是单层目录，因此构建时清理所有旧式目录。
  for (const entry of readdirSync(installersRoot, { withFileTypes: true })) {
    if (entry.isDirectory()) rmSync(resolve(installersRoot, entry.name), { recursive: true, force: true })
  }
  const destination = resolve(installersRoot, publishedFilename)
  const temporary = `${destination}.tmp-${process.pid}`
  rmSync(temporary, { force: true })
  copyFileSync(builtArtifact, temporary)
  rmSync(destination, { force: true })
  renameSync(temporary, destination)
  rmSync(bundleRoot, { recursive: true, force: true })
  return destination
}

function newestFile(directory, predicate) {
  if (!existsSync(directory)) return null
  return readdirSync(directory)
    .filter(predicate)
    .map(entry => resolve(directory, entry))
    .filter(path => statSync(path).isFile())
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0] ?? null
}

function findFiles(directory, predicate) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...findFiles(path, predicate))
    else if (entry.isFile() && predicate(path)) files.push(path)
  }
  return files
}

function deepMerge(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const current = target[key]
      if (!current || typeof current !== 'object' || Array.isArray(current)) target[key] = {}
      deepMerge(target[key], value)
    } else {
      target[key] = value
    }
  }
  return target
}
