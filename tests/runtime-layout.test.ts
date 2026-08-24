import { existsSync, linkSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { materializeProductionRuntime, sanitizeProductionRuntime } from '../scripts/lib/runtime.mjs'

describe('production runtime layout', () => {
  it('removes upstream sources and temporary deploy metadata', () => {
    const buildRoot = join(process.env.TMPDIR ?? '/tmp', `dsh-app-build-${process.pid}-${Math.random()}`)
    const runtime = join(process.env.TMPDIR ?? '/tmp', `dsh-app-runtime-${process.pid}-${Math.random()}`)
    const packageRoot = join(runtime, 'node_modules/@deepseek-ai/example')
    mkdirSync(join(packageRoot, 'src'), { recursive: true })
    mkdirSync(join(packageRoot, 'lib'), { recursive: true })
    writeFileSync(join(packageRoot, 'src/index.ts'), 'export const source = true\n')
    writeFileSync(
      join(packageRoot, 'lib/client.js'),
      `//#region \\0dsh-css:${buildRoot}/packages/example/src/style.css.mjs\n`
      + `//#region \\0dsh-inline-css:${buildRoot}/packages/example/src/base.css.mjs\n`
      + 'export const css = true\n',
    )
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/example',
      version: '1.2.3',
      files: ['lib', 'src', 'src/native.c', './src/generated.ts', '!src/private.ts'],
      exports: { '.': './lib/index.js', './src/*': './src/*' },
    }))
    writeFileSync(join(runtime, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh',
      dependencies: { '@deepseek-ai/example': `@deepseek-ai/example@file://${buildRoot}/example` },
    }))
    writeFileSync(join(runtime, 'pnpm-lock.yaml'), `path: ${buildRoot}\n`)
    writeFileSync(join(runtime, 'pnpm-workspace.yaml'), 'packages: []\n')
    mkdirSync(join(runtime, 'node_modules/.pnpm'), { recursive: true })
    writeFileSync(join(runtime, 'node_modules/.modules.yaml'), `path: ${buildRoot}\n`)
    writeFileSync(join(runtime, 'node_modules/.pnpm/lock.yaml'), 'lockfileVersion: 9\n')
    writeFileSync(join(runtime, 'node_modules/.pnpm-workspace-state-v1.json'), '{}\n')

    expect(sanitizeProductionRuntime({
      runtimeRoot: runtime,
      workspacePackageNames: ['@deepseek-ai/example'],
      forbiddenBuildRoot: buildRoot,
    })).toEqual({ packages: 1, sourceDirectories: 1, buildPathMarkers: 2 })

    const deployed = JSON.parse(readFileSync(join(runtime, 'package.json'), 'utf8'))
    const workspace = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
    expect(deployed.dependencies['@deepseek-ai/example']).toBe('1.2.3')
    expect(workspace.files).toEqual(['lib'])
    expect(workspace.exports['./src/*']).toBeUndefined()
    expect(readFileSync(join(packageRoot, 'lib/client.js'), 'utf8')).toContain('dsh-source/packages/example')
    expect(existsSync(join(packageRoot, 'src'))).toBe(false)
    expect(existsSync(join(runtime, 'pnpm-lock.yaml'))).toBe(false)
    expect(existsSync(join(runtime, 'pnpm-workspace.yaml'))).toBe(false)
    expect(existsSync(join(runtime, 'node_modules/.modules.yaml'))).toBe(false)
    expect(existsSync(join(runtime, 'node_modules/.pnpm/lock.yaml'))).toBe(false)
    expect(existsSync(join(runtime, 'node_modules/.pnpm-workspace-state-v1.json'))).toBe(false)
  })

  it('publishes files independently from pnpm deploy and its mutable workspace inputs', () => {
    const root = join(process.env.TMPDIR ?? '/tmp', `dsh-app-runtime-isolation-${process.pid}-${Math.random()}`)
    const workspace = join(root, 'workspace')
    const deployed = join(root, 'deployed')
    const published = join(root, 'published')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(join(deployed, 'lib'), { recursive: true })
    const workspaceClient = join(workspace, 'client.js')
    const deployedClient = join(deployed, 'lib/client.js')
    const publishedClient = join(published, 'lib/client.js')
    writeFileSync(workspaceClient, 'export const version = "old"\n')
    linkSync(workspaceClient, deployedClient)

    const isolation = materializeProductionRuntime(deployed, published)
    expect(isolation.checkedFiles).toBe(1)
    expect(statSync(publishedClient).ino).not.toBe(statSync(deployedClient).ino)

    // 后续构建即使覆盖 workspace 硬链接，也不能再改变已发布运行时。
    writeFileSync(workspaceClient, 'export const version = "new"\n')
    expect(readFileSync(deployedClient, 'utf8')).toBe('export const version = "new"\n')
    expect(readFileSync(publishedClient, 'utf8')).toBe('export const version = "old"\n')
  })
})
