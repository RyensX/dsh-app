import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { build } from 'esbuild'
import { z } from 'zod'
import { targetInfo } from './targets.mjs'

const relativePath = z.string().min(1).refine(value => !isAbsolute(value) && !value.split(/[\\/]/u).includes('..'), {
  message: 'must be a contained relative path',
})

export const pluginManifestSchema = z.strictObject({
  $schema: z.string().optional(),
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
  enabled: z.boolean(),
  entry: relativePath,
  source: relativePath.optional(),
  client: z.strictObject({
    entry: relativePath,
    source: relativePath,
    inject: z.array(z.string().min(1)).refine(values => new Set(values).size === values.length, {
      message: 'client inject entries must be unique',
    }).optional(),
    immediately: z.boolean().optional(),
  }).optional(),
  targets: z.array(z.enum(['macos', 'windows'])).min(1).refine(values => new Set(values).size === values.length, {
    message: 'targets must be unique',
  }),
  editions: z.array(z.enum(['bundled', 'lite'])).min(1).optional()
    .refine(values => values === undefined || new Set(values).size === values.length, {
      message: 'editions must be unique',
    }),
  config: z.unknown(),
})

const PLUGIN_VERSION = '0.0.0'

function portable(path) {
  return path.split('\\').join('/')
}

function packageExport(path) {
  return `./${portable(path)}`
}

function contained(root, child) {
  const path = resolve(root, child)
  const rel = relative(resolve(root), path)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${child} escapes ${root}`)
  return path
}

export function discoverPlugins(pluginsRoot) {
  let directories = []
  try {
    directories = readdirSync(pluginsRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }

  const ids = new Set()
  return directories.map(directory => {
    const root = resolve(pluginsRoot, directory)
    const manifestPath = resolve(root, 'dsh-app.plugin.json')
    let source
    try {
      source = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch (error) {
      throw new Error(`cannot read ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`)
    }
    const result = pluginManifestSchema.safeParse(source)
    if (!result.success) throw new Error(`invalid ${manifestPath}: ${result.error.message}`)
    if (ids.has(result.data.id)) throw new Error(`duplicate plugin id: ${result.data.id}`)
    ids.add(result.data.id)
    return { root, manifestPath, manifest: result.data }
  })
}

export function selectPlugins(plugins, target, edition = 'bundled') {
  return plugins.filter(plugin => (
    plugin.manifest.enabled
    && plugin.manifest.targets.includes(target)
    && (plugin.manifest.editions === undefined || plugin.manifest.editions.includes(edition))
  ))
}

export async function buildPlugins({ pluginsRoot, runtimeRoot, target, edition = 'bundled' }) {
  const selected = selectPlugins(discoverPlugins(pluginsRoot), target, edition)
  const outputRoot = resolve(runtimeRoot, 'plugins')
  mkdirSync(outputRoot, { recursive: true })
  const index = []

  for (const plugin of selected) {
    const source = contained(plugin.root, plugin.manifest.source ?? plugin.manifest.entry)
    if (!statSync(source).isFile()) throw new Error(`plugin source is not a file: ${source}`)
    const packagedRoot = resolve(runtimeRoot, 'node_modules', plugin.manifest.id)
    if (existsSync(packagedRoot)) {
      throw new Error(`plugin package conflicts with an existing runtime dependency: ${plugin.manifest.id}`)
    }
    const outfile = contained(packagedRoot, plugin.manifest.entry)
    mkdirSync(dirname(outfile), { recursive: true })
    await build({
      entryPoints: [source],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node22.19',
      sourcemap: false,
      legalComments: 'eof',
      define: { __DSH_APP_EDITION__: JSON.stringify(edition) },
      external: ['@deepseek-ai/*', 'cordis'],
    })

    if (plugin.manifest.client !== undefined) {
      const clientSource = contained(plugin.root, plugin.manifest.client.source)
      if (!statSync(clientSource).isFile()) throw new Error(`plugin client source is not a file: ${clientSource}`)
      const clientOutfile = contained(packagedRoot, plugin.manifest.client.entry)
      mkdirSync(dirname(clientOutfile), { recursive: true })
      await build({
        entryPoints: [clientSource],
        outfile: clientOutfile,
        bundle: true,
        format: 'cjs',
        platform: 'browser',
        target: 'es2022',
        sourcemap: false,
        legalComments: 'eof',
        // 内置客户端插件可将小型品牌图片直接编入 bundle，避免新增远程资源权限。
        loader: { '.png': 'dataurl' },
        define: { __DSH_APP_EDITION__: JSON.stringify(edition) },
        external: [
          '@deepseek-ai/*',
          'react',
          'react/*',
        ],
        banner: {
          js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(plugin.manifest.id)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
        },
        footer: { js: 'return module.exports; } });' },
      })
    }

    const packageManifest = {
      name: plugin.manifest.id,
      version: PLUGIN_VERSION,
      private: true,
      type: 'module',
      main: packageExport(plugin.manifest.entry),
      exports: {
        '.': packageExport(plugin.manifest.entry),
        ...(plugin.manifest.client === undefined
          ? {}
          : { './client': packageExport(plugin.manifest.client.entry) }),
        './package.json': './package.json',
      },
      ...(plugin.manifest.client === undefined
        ? {}
        : {
            dsh: {
              client: {
                platform: 'web',
                ...(plugin.manifest.client.inject === undefined
                  ? {}
                  : { inject: plugin.manifest.client.inject }),
                ...(plugin.manifest.client.immediately === undefined
                  ? {}
                  : { immediately: plugin.manifest.client.immediately }),
              },
            },
          }),
    }
    writeFileSync(resolve(packagedRoot, 'package.json'), `${JSON.stringify(packageManifest, null, 2)}\n`)
    const packagedManifest = resolve(packagedRoot, 'dsh-app.plugin.json')
    copyFileSync(plugin.manifestPath, packagedManifest)
    index.push({
      id: plugin.manifest.id,
      entry: portable(relative(runtimeRoot, outfile)),
      config: plugin.manifest.config,
      manifest: portable(relative(runtimeRoot, packagedManifest)),
    })
  }

  if (selected.length > 0) {
    const runtimeManifestPath = resolve(runtimeRoot, 'package.json')
    const runtimeManifest = JSON.parse(readFileSync(runtimeManifestPath, 'utf8'))
    runtimeManifest.dependencies ??= {}
    for (const plugin of selected) runtimeManifest.dependencies[plugin.manifest.id] = PLUGIN_VERSION
    writeFileSync(runtimeManifestPath, `${JSON.stringify(runtimeManifest, null, 2)}\n`)
  }

  writeFileSync(resolve(outputRoot, 'index.json'), `${JSON.stringify({ schemaVersion: 1, plugins: index }, null, 2)}\n`)
  return index
}

/** Build target-selected app plugins independently so Lite never has to package dsh. */
export async function buildPluginPayload({
  pluginsRoot,
  payloadRoot,
  platform,
  targetTriple,
  edition,
}) {
  if (targetInfo(targetTriple).appTarget !== platform) {
    throw new Error(`plugin platform ${platform} does not match target triple ${targetTriple}`)
  }
  mkdirSync(payloadRoot, { recursive: true })
  writeFileSync(resolve(payloadRoot, 'package.json'), '{"name":"dsh-app-plugin-payload","private":true,"dependencies":{}}\n')
  const plugins = await buildPlugins({ pluginsRoot, runtimeRoot: payloadRoot, target: platform, edition })
  const digest = hashPayload(payloadRoot)
  writeFileSync(resolve(payloadRoot, 'payload.json'), `${JSON.stringify({
    schemaVersion: 2,
    edition,
    platform,
    targetTriple,
    digest,
    plugins: plugins.map(plugin => ({ id: plugin.id, entry: plugin.entry })),
  }, null, 2)}\n`)
  return { plugins, digest }
}

export function injectPluginPayload({ payloadRoot, runtimeRoot }) {
  const payload = JSON.parse(readFileSync(resolve(payloadRoot, 'payload.json'), 'utf8'))
  const runtimeManifestPath = resolve(runtimeRoot, 'package.json')
  const runtimeManifest = JSON.parse(readFileSync(runtimeManifestPath, 'utf8'))
  runtimeManifest.dependencies ??= {}

  mkdirSync(resolve(runtimeRoot, 'plugins'), { recursive: true })
  copyFileSync(resolve(payloadRoot, 'plugins/index.json'), resolve(runtimeRoot, 'plugins/index.json'))
  for (const plugin of payload.plugins) {
    const source = resolve(payloadRoot, 'node_modules', plugin.id)
    const destination = resolve(runtimeRoot, 'node_modules', plugin.id)
    if (existsSync(destination)) throw new Error(`plugin package conflicts with dsh runtime dependency: ${plugin.id}`)
    copyTree(source, destination)
    runtimeManifest.dependencies[plugin.id] = PLUGIN_VERSION
  }
  writeFileSync(runtimeManifestPath, `${JSON.stringify(runtimeManifest, null, 2)}\n`)
  return payload
}

function copyTree(source, destination) {
  mkdirSync(destination, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = resolve(source, entry.name)
    const to = resolve(destination, entry.name)
    if (entry.isDirectory()) copyTree(from, to)
    else if (entry.isFile()) copyFileSync(from, to)
    else throw new Error(`plugin payload contains an unsupported entry: ${from}`)
  }
}

function hashPayload(root) {
  const hash = createHash('sha256')
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve(directory, entry.name)
      const name = portable(relative(root, path))
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) hash.update(name).update('\0').update(readFileSync(path)).update('\0')
    }
  }
  visit(root)
  return hash.digest('hex')
}
