import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, copyFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { basename, dirname, resolve } from 'node:path'
import { run } from './process.mjs'

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'error' })
  if (!response.ok || !response.body) throw new Error(`download failed (${response.status}): ${url}`)
  mkdirSync(dirname(destination), { recursive: true })
  const temporary = `${destination}.download`
  const output = createWriteStream(temporary, { flags: 'w' })
  await finished(Readable.fromWeb(response.body).pipe(output))
  rmSync(destination, { force: true })
  copyFileSync(temporary, destination)
  rmSync(temporary, { force: true })
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function expectedHash(shasums, archive) {
  const escaped = archive.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const match = new RegExp(`^([a-f0-9]{64})  ${escaped}$`, 'mu').exec(shasums)
  if (!match?.[1]) throw new Error(`${archive} is absent from Node SHASUMS256.txt`)
  return match[1]
}

function extractArchive(archive, destination) {
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })
  if (process.platform === 'win32') {
    const command = `Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${destination.replaceAll("'", "''")}' -Force`
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command])
  } else {
    run('tar', ['-xzf', archive, '-C', destination])
  }
}

export async function prepareNodeDistribution({ root, target, version, baseUrl, copySidecar = false }) {
  const cache = resolve(root, '.build/cache/node', `v${version}`)
  const archiveName = target.nodeArchive(version)
  const archive = resolve(cache, archiveName)
  const sums = resolve(cache, 'SHASUMS256.txt')
  const versionUrl = `${baseUrl}/v${version}`
  if (!existsSync(sums)) await download(`${versionUrl}/SHASUMS256.txt`, sums)
  if (!existsSync(archive)) await download(`${versionUrl}/${archiveName}`, archive)
  const expected = expectedHash(readFileSync(sums, 'utf8'), archiveName)
  const actual = sha256(archive)
  if (actual !== expected) throw new Error(`Node archive checksum mismatch: expected ${expected}, got ${actual}`)

  const extracted = resolve(cache, 'extracted')
  const top = archiveName.replace(/\.(?:tar\.gz|zip)$/u, '')
  const layout = nodeDistributionLayout(target)
  const nodeSource = resolve(extracted, top, layout.nodeExecutable)
  const corepack = resolve(extracted, top, layout.corepack)
  const corepackEntry = resolve(corepack, 'dist/corepack.js')
  if (!existsSync(nodeSource) || !existsSync(corepackEntry)) extractArchive(archive, extracted)
  if (!existsSync(nodeSource)) throw new Error(`Node executable missing after extraction: ${nodeSource}`)
  if (!existsSync(corepackEntry)) throw new Error(`Corepack entrypoint missing after extraction: ${corepackEntry}`)

  let sidecar = null
  if (copySidecar) {
    sidecar = resolve(root, 'src-tauri/binaries', `node-${target.triple}${layout.sidecarSuffix}`)
    mkdirSync(dirname(sidecar), { recursive: true })
    copyFileSync(nodeSource, sidecar)
    if (target.nodePlatform !== 'win32') run('chmod', ['755', sidecar])
  }

  return {
    executable: nodeSource,
    distribution: resolve(extracted, top),
    corepack,
    sidecar,
    license: resolve(extracted, top, 'LICENSE'),
    archive: basename(archive),
    sha256: actual,
  }
}

export function nodeDistributionLayout(target) {
  if (target.nodePlatform === 'win32') {
    return {
      nodeExecutable: 'node.exe',
      corepack: 'node_modules/corepack',
      sidecarSuffix: '.exe',
    }
  }
  return {
    nodeExecutable: 'bin/node',
    corepack: 'lib/node_modules/corepack',
    sidecarSuffix: '',
  }
}

export function prepareBundledNode(options) {
  return prepareNodeDistribution({ ...options, copySidecar: true })
}
