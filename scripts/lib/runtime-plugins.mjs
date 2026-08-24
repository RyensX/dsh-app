import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { assertPluginPayloadIdentity } from './plugin-payload-contract.mjs'

const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u

/**
 * 只刷新 App 自带插件，不改动已经编译好的 dsh 与原生依赖。
 * 清单最后写入：即使进程中途退出，下次启动仍会因旧 digest 再次修复。
 */
export function refreshRuntimePlugins({ installRoot, payloadRoot, bootstrap }) {
  const runtimeRoot = resolve(installRoot, 'dsh-runtime')
  const manifestPath = resolve(installRoot, 'runtime-manifest.json')
  const runtimePackagePath = resolve(runtimeRoot, 'package.json')
  const runtimeIndexPath = resolve(runtimeRoot, 'plugins/index.json')
  const payload = readJson(resolve(payloadRoot, 'payload.json'))
  const payloadIndex = readJson(resolve(payloadRoot, 'plugins/index.json'))
  const manifest = readJson(manifestPath)
  const runtimePackage = readJson(runtimePackagePath)

  assertRefreshContract({ bootstrap, payload, payloadIndex, manifest, runtimeRoot })
  const oldIds = new Set((manifest.plugins ?? []).map(plugin => checkedPluginId(plugin.id)))
  const newIds = new Set(payload.plugins.map(plugin => checkedPluginId(plugin.id)))

  // 所有载荷先完成身份、入口、冲突和 package 校验，避免验证失败时留下半刷新状态。
  const replacements = payload.plugins.map(plugin => {
    assertPluginEntry(plugin)
    const source = resolve(payloadRoot, 'node_modules', plugin.id)
    const destination = resolve(runtimeRoot, 'node_modules', plugin.id)
    if (!existsSync(source)) throw new Error(`app plugin payload is missing: ${plugin.id}`)
    if (existsSync(destination) && !oldIds.has(plugin.id)) {
      throw new Error(`app plugin conflicts with a dsh runtime dependency: ${plugin.id}`)
    }
    const packageManifest = readJson(resolve(source, 'package.json'))
    if (packageManifest.name !== plugin.id) {
      throw new Error(`app plugin package name mismatch: ${plugin.id}`)
    }
    return { source, destination }
  })
  for (const { source, destination } of replacements) {
    replaceDirectory(source, destination)
  }

  mkdirSync(dirname(runtimeIndexPath), { recursive: true })
  atomicJson(runtimeIndexPath, payloadIndex)

  runtimePackage.dependencies ??= {}
  for (const id of oldIds) delete runtimePackage.dependencies[id]
  for (const id of newIds) runtimePackage.dependencies[id] = '0.0.0'
  atomicJson(runtimePackagePath, runtimePackage)

  for (const id of oldIds) {
    if (!newIds.has(id)) rmSync(resolve(runtimeRoot, 'node_modules', id), { recursive: true, force: true })
  }

  manifest.app.version = bootstrap.app.version
  manifest.plugins = payload.plugins
  manifest.pluginDigest = payload.digest
  if (
    manifest.dsh?.commitTime === undefined
    && manifest.dsh?.commit === bootstrap.dsh?.commit
    && typeof bootstrap.dsh?.commitTime === 'string'
  ) {
    manifest.dsh.commitTime = bootstrap.dsh.commitTime
  }
  atomicJson(manifestPath, manifest)

  return {
    pluginDigest: payload.digest,
    plugins: payload.plugins,
  }
}

function assertRefreshContract({ bootstrap, payload, payloadIndex, manifest, runtimeRoot }) {
  assertPluginPayloadIdentity({ bootstrap, payload, payloadIndex })
  if (
    manifest?.schemaVersion !== 1
    || manifest.app?.edition !== 'managed'
    || manifest.app?.target !== bootstrap.app?.target
  ) throw new Error('runtime plugin refresh manifest does not match the app')
  if (!existsSync(resolve(runtimeRoot, 'package.json'))) {
    throw new Error('compiled dsh runtime is missing package.json')
  }
}

function assertPluginEntry(plugin) {
  checkedPluginId(plugin.id)
  if (
    typeof plugin.entry !== 'string'
    || !plugin.entry.startsWith(`node_modules/${plugin.id}/`)
    || plugin.entry.split('/').includes('..')
  ) throw new Error(`app plugin entry is invalid: ${String(plugin.entry)}`)
}

function checkedPluginId(value) {
  if (typeof value !== 'string' || !PLUGIN_ID_PATTERN.test(value)) {
    throw new Error(`app plugin id is invalid: ${String(value)}`)
  }
  return value
}

function replaceDirectory(source, destination) {
  const temporary = `${destination}.dsh-app-next-${process.pid}`
  const backup = `${destination}.dsh-app-previous-${process.pid}`
  rmSync(temporary, { recursive: true, force: true })
  rmSync(backup, { recursive: true, force: true })
  cpSync(source, temporary, { recursive: true, errorOnExist: true, force: false })
  let movedPrevious = false
  try {
    if (existsSync(destination)) {
      renameSync(destination, backup)
      movedPrevious = true
    }
    renameSync(temporary, destination)
    rmSync(backup, { recursive: true, force: true })
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true })
    if (movedPrevious && !existsSync(destination) && existsSync(backup)) {
      try { renameSync(backup, destination) } catch {}
    }
    throw error
  }
}

function atomicJson(path, value) {
  const temporary = `${path}.dsh-app-next-${process.pid}`
  const backup = `${path}.dsh-app-previous-${process.pid}`
  rmSync(temporary, { force: true })
  rmSync(backup, { force: true })
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
  let movedPrevious = false
  try {
    if (existsSync(path)) {
      renameSync(path, backup)
      movedPrevious = true
    }
    renameSync(temporary, path)
    rmSync(backup, { force: true })
  } catch (error) {
    rmSync(temporary, { force: true })
    if (movedPrevious && !existsSync(path) && existsSync(backup)) {
      try { renameSync(backup, path) } catch {}
    }
    throw error
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}
