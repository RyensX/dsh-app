import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import semver from 'semver'
import { isMap, parseDocument } from 'yaml'
import { z } from 'zod'

const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u
const githubSourcePattern = /^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#[^\s#]+)?$/u

const remotePluginSchema = z.strictObject({
  name: z.string().regex(packageNamePattern, 'must be an npm package name'),
  source: z.string().min(1),
  policy: z.enum(['default', 'required']),
  allowBuild: z.boolean().optional().default(false),
  targets: z.array(z.enum(['macos', 'windows'])).min(1)
    .refine(values => new Set(values).size === values.length, { message: 'targets must be unique' }),
  editions: z.array(z.enum(['bundled', 'lite'])).min(1).optional()
    .refine(values => values === undefined || new Set(values).size === values.length, {
      message: 'editions must be unique',
    }),
}).superRefine((plugin, context) => {
  if (githubSourcePattern.test(plugin.source) || plugin.source === plugin.name) return
  const prefix = `${plugin.name}@`
  if (!plugin.source.startsWith(prefix) || semver.valid(plugin.source.slice(prefix.length)) === null) {
    context.addIssue({
      code: 'custom',
      path: ['source'],
      message: 'must be <name>, github:owner/repository[#ref], or <name>@<exact-version>',
    })
  }
})

export const remotePluginManifestSchema = z.strictObject({
  $schema: z.string().optional(),
  schemaVersion: z.literal(1),
  plugins: z.array(remotePluginSchema).superRefine((plugins, context) => {
    const names = new Set()
    for (let index = 0; index < plugins.length; index += 1) {
      const name = plugins[index].name
      if (names.has(name)) {
        context.addIssue({ code: 'custom', path: [index, 'name'], message: `duplicate plugin name: ${name}` })
      }
      names.add(name)
    }
  }),
})

const remotePluginStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  plugins: z.record(z.string(), z.strictObject({
    source: z.string().min(1),
    dependency: z.string().min(1),
  })),
})

export function readRemotePluginManifest(path) {
  let source
  try {
    source = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const result = remotePluginManifestSchema.safeParse(source)
  if (!result.success) throw new Error(`invalid ${path}: ${result.error.message}`)
  return result.data
}

export function selectRemotePlugins(manifest, target, edition) {
  return {
    ...manifest,
    plugins: manifest.plugins.filter(plugin => (
      plugin.targets.includes(target)
      && (plugin.editions === undefined || plugin.editions.includes(edition))
    )),
  }
}

/**
 * 将 App 声明的远程插件收敛到 web profile。状态文件界定 App 所有权，
 * 遇到用户已有的同名、不同来源依赖时不会静默覆盖。
 */
export function reconcileRemotePlugins({
  manifest,
  target,
  edition,
  profileHome,
  statePath,
  initializeProfile,
  installPlugin,
  removePlugin = undefined,
}) {
  const selected = selectRemotePlugins(manifest, target, edition).plugins
  const profileDir = resolve(profileHome, 'profiles/web')
  const state = readState(statePath)
  const present = []
  const installed = []
  const failures = []
  const pending = []
  const repairs = new Set()
  let stateChanged = false

  for (const plugin of selected) {
    const dependency = readDependency(profileDir, plugin.name)
    const inspection = inspectInstalledBundle(profileDir, plugin.name)
    const owned = state.plugins[plugin.name]
    if (
      inspection.ok
      && (
        (owned !== undefined && owned.source === plugin.source && owned.dependency === dependency)
        || (owned === undefined && dependency === plugin.source)
      )
    ) {
      present.push(plugin.name)
      continue
    }
    if (dependency !== undefined && dependency !== plugin.source && owned === undefined) {
      failures.push(failure(plugin, `profile already declares ${plugin.name} from ${dependency}`))
      continue
    }
    if (!inspection.ok && dependency !== undefined && owned !== undefined) repairs.add(plugin.name)
    pending.push(plugin)
  }

  // 首次安装即建立 App 所有权，确保一次部分失败不会在下次启动时被误判成用户冲突。
  for (const plugin of pending) {
    if (state.plugins[plugin.name] !== undefined) continue
    state.plugins[plugin.name] = {
      source: plugin.source,
      dependency: readDependency(profileDir, plugin.name) ?? plugin.source,
    }
    stateChanged = true
  }

  if (pending.length > 0) {
    try {
      initializeProfile()
    } catch (error) {
      const message = boundedError(error)
      for (const plugin of pending.splice(0)) failures.push(failure(plugin, message))
    }
  }

  for (const plugin of pending) {
    try {
      if (repairs.has(plugin.name)) {
        if (typeof removePlugin !== 'function') throw new Error(`cannot repair ${plugin.name} without a remove handler`)
        removePlugin(plugin)
      }
      if (plugin.allowBuild) allowProfileBuild(profileDir, plugin.name)
      try {
        installPlugin(plugin)
      } catch (error) {
        const buildKey = plugin.allowBuild ? pnpmGitBuildKey(error, plugin.name) : null
        if (buildKey === null || !allowProfileBuildKey(profileDir, buildKey)) throw error
        // pnpm 对 GitHub prepare 脚本要求精确 codeload 定位符，补充授权后只重试一次。
        installPlugin(plugin)
      }
      let dependency = readDependency(profileDir, plugin.name)
      let inspection = inspectInstalledBundle(profileDir, plugin.name)
      if (!inspection.ok && plugin.allowBuild) {
        const buildKey = lockedGitBuildKey(profileDir, plugin)
        if (buildKey !== null && allowProfileBuildKey(profileDir, buildKey)) {
          if (typeof removePlugin !== 'function') throw new Error(`cannot repair ${plugin.name} without a remove handler`)
          // 有些 pnpm 路径以成功状态留下未构建包；精确授权后必须移除再安装才能执行 prepare。
          removePlugin(plugin)
          installPlugin(plugin)
          dependency = readDependency(profileDir, plugin.name)
          inspection = inspectInstalledBundle(profileDir, plugin.name)
        }
      }
      if (dependency === undefined) throw new Error(`${plugin.name} was not added to profile dependencies`)
      if (!inspection.ok) throw new Error(inspection.reason)
      state.plugins[plugin.name] = { source: plugin.source, dependency }
      stateChanged = true
      installed.push(plugin.name)
    } catch (error) {
      let message = boundedError(error)
      // App 管理的插件失败后必须回滚，否则 default 插件的半安装 bundle 会阻断整个 dsh 启动。
      if (typeof removePlugin === 'function' && readDependency(profileDir, plugin.name) !== undefined) {
        try {
          removePlugin(plugin)
        } catch (cleanupError) {
          message = `${message}; cleanup failed: ${boundedError(cleanupError)}`
        }
      }
      failures.push(failure(plugin, message))
    }
  }

  if (stateChanged) atomicJson(statePath, state)
  const report = { present, installed, failures }
  const required = failures.filter(item => item.policy === 'required')
  if (required.length > 0) {
    throw new Error(`required remote plugins failed: ${required.map(item => `${item.name}: ${item.message}`).join('; ')}`)
  }
  return report
}

export function allowProfileBuild(profileDir, packageName) {
  allowProfileBuildKey(profileDir, packageName)
}

function allowProfileBuildKey(profileDir, buildKey) {
  const workspacePath = resolve(profileDir, 'pnpm-workspace.yaml')
  if (!existsSync(workspacePath)) throw new Error(`profile pnpm workspace is missing: ${workspacePath}`)
  const document = parseDocument(readFileSync(workspacePath, 'utf8'))
  if (document.errors.length > 0) {
    throw new Error(`profile pnpm workspace is invalid: ${document.errors[0].message}`)
  }
  let allowBuilds = document.get('allowBuilds', true)
  if (allowBuilds === undefined) {
    document.setIn(['allowBuilds', buildKey], true)
    atomicText(workspacePath, document.toString())
    return true
  }
  if (!isMap(allowBuilds)) throw new Error('profile allowBuilds must be a YAML mapping')
  if (allowBuilds.get(buildKey) === true) return false
  allowBuilds.set(buildKey, true)
  atomicText(workspacePath, document.toString())
  return true
}

function pnpmGitBuildKey(error, packageName) {
  const message = error instanceof Error ? error.message : String(error)
  const expectedPrefix = `${packageName}@https://codeload.github.com/`
  const validKey = key => (
    key.startsWith(expectedPrefix)
    && /\/tar\.gz\/[0-9a-f]{40}$/iu.test(key)
  )
  for (const match of message.matchAll(/(?:^|\r?\n)allowBuilds:\r?\n[ \t]+([^\r\n]+): true/gu)) {
    const key = match[1].trim()
    if (validKey(key)) return key
  }
  for (const match of message.matchAll(/Ignored build scripts:[ \t]+([^\r\n]+)/gu)) {
    for (const candidate of match[1].split(',')) {
      const key = candidate.trim()
      if (validKey(key)) return key
    }
  }
  return null
}

function lockedGitBuildKey(profileDir, plugin) {
  const source = /^github:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:#[^\s#]+)?$/u.exec(plugin.source)
  if (source === null) return null
  const lockPath = resolve(profileDir, 'pnpm-lock.yaml')
  if (!existsSync(lockPath)) return null
  const document = parseDocument(readFileSync(lockPath, 'utf8'))
  if (document.errors.length > 0) return null
  const declaration = document.toJS()?.importers?.['.']?.dependencies?.[plugin.name]
  if (declaration?.specifier !== plugin.source || typeof declaration.version !== 'string') return null
  const expected = `https://codeload.github.com/${source[1]}/${source[2]}/tar.gz/`
  if (!declaration.version.startsWith(expected) || !/[0-9a-f]{40}$/iu.test(declaration.version)) return null
  return `${plugin.name}@${declaration.version}`
}

function readState(path) {
  if (!existsSync(path)) return { schemaVersion: 1, plugins: {} }
  let source
  try {
    source = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const result = remotePluginStateSchema.safeParse(source)
  if (!result.success) throw new Error(`invalid ${path}: ${result.error.message}`)
  for (const name of Object.keys(result.data.plugins)) {
    if (!packageNamePattern.test(name)) throw new Error(`invalid managed remote plugin name: ${name}`)
  }
  return result.data
}

function readDependency(profileDir, name) {
  const path = resolve(profileDir, 'package.json')
  if (!existsSync(path)) return undefined
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  const value = manifest.dependencies?.[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) throw new Error(`profile dependency ${name} is invalid`)
  return value
}

function inspectInstalledBundle(profileDir, name) {
  const packageRoot = resolve(profileDir, 'node_modules', ...name.split('/'))
  const manifestPath = resolve(packageRoot, 'package.json')
  if (!existsSync(manifestPath)) return { ok: false, reason: `${name} is not installed` }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    return { ok: false, reason: `${name} package manifest is invalid: ${boundedError(error)}` }
  }
  if (manifest.name !== name) return { ok: false, reason: `${name} package name does not match its catalog entry` }
  const entry = packageEntry(manifest)
  if (entry !== null) {
    let entryPath
    try {
      entryPath = contained(packageRoot, entry, 'package entry')
    } catch (error) {
      return { ok: false, reason: boundedError(error) }
    }
    if (!existsSync(entryPath) || !statSync(entryPath).isFile()) {
      return { ok: false, reason: `${name} package entry is missing: ${entry}` }
    }
  }
  const patch = manifest.dsh?.bundle?.patch
  if (typeof patch !== 'string' || patch.length === 0) {
    return { ok: false, reason: `${name} does not declare dsh.bundle.patch` }
  }
  let patchPath
  try {
    patchPath = contained(packageRoot, patch)
  } catch (error) {
    return { ok: false, reason: boundedError(error) }
  }
  if (!existsSync(patchPath) || !statSync(patchPath).isFile()) {
    return { ok: false, reason: `${name} bundle patch is missing: ${patch}` }
  }
  const profilePath = resolve(profileDir, 'package.json')
  const profile = JSON.parse(readFileSync(profilePath, 'utf8'))
  if (!profile.dsh?.profile?.bundles?.includes(name)) {
    return { ok: false, reason: `${name} was not activated as a dsh profile bundle` }
  }
  return { ok: true }
}

function packageEntry(manifest) {
  if (typeof manifest.exports === 'string' && manifest.exports.length > 0) return manifest.exports
  const rootExport = manifest.exports?.['.']
  if (typeof rootExport === 'string' && rootExport.length > 0) return rootExport
  if (rootExport && typeof rootExport === 'object') {
    for (const condition of ['import', 'default', 'require']) {
      const value = rootExport[condition]
      if (typeof value === 'string' && value.length > 0) return value
    }
  }
  if (typeof manifest.main === 'string' && manifest.main.length > 0) return manifest.main
  return null
}

function contained(root, value, label = 'bundle patch') {
  if (isAbsolute(value) || value.split(/[\\/]/u).includes('..')) {
    throw new Error(`${label} must be a contained relative path: ${value}`)
  }
  const path = resolve(root, value)
  const rel = relative(resolve(root), path)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${label} escapes its package: ${value}`)
  return path
}

function failure(plugin, message) {
  return { name: plugin.name, policy: plugin.policy, message }
}

function boundedError(error) {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > 4_000 ? `${text.slice(0, 3_997)}...` : text
}

function atomicJson(path, value) {
  atomicText(path, `${JSON.stringify(value, null, 2)}\n`)
}

function atomicText(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.dsh-app-next-${process.pid}`
  const backup = `${path}.dsh-app-previous-${process.pid}`
  rmSync(temporary, { force: true })
  rmSync(backup, { force: true })
  writeFileSync(temporary, value, { flag: 'wx' })
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
