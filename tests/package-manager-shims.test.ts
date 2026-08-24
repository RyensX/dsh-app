import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeNpmCompatibilityShims } from '../scripts/lib/package-manager-shims.mjs'

const fixtures: string[] = []

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true })
})

describe('package-manager compatibility shims', () => {
  it('routes pnpm, npm run and npx through the pinned pnpm Corepack command', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-app-package-shims-'))
    fixtures.push(root)
    const shimRoot = join(root, 'shim directory')
    const fakeRoot = join(root, 'fake corepack')
    const fakeCorepack = join(fakeRoot, 'corepack fixture.mjs')
    const capture = join(root, 'capture.json')
    mkdirSync(fakeRoot, { recursive: true })
    writeFileSync(fakeCorepack, [
      "import { writeFileSync } from 'node:fs'",
      "writeFileSync(process.env.SHIM_CAPTURE, JSON.stringify(process.argv.slice(2)))",
      '',
    ].join('\n'))
    writeNpmCompatibilityShims({
      directory: shimRoot,
      nodeExecutable: process.execPath,
      corepack: fakeCorepack,
      packageManager: 'pnpm@fixture',
    })

    executeShim(shimRoot, 'pnpm', ['add', 'fixture'], capture)
    expect(JSON.parse(readFileSync(capture, 'utf8'))).toEqual([
      'pnpm@fixture', 'add', 'fixture',
    ])

    executeShim(shimRoot, 'npm', ['run', 'build:lib'], capture)
    expect(JSON.parse(readFileSync(capture, 'utf8'))).toEqual([
      'pnpm@fixture', 'run', 'build:lib',
    ])

    executeShim(shimRoot, 'npx', ['tsx', 'script.ts'], capture)
    expect(JSON.parse(readFileSync(capture, 'utf8'))).toEqual([
      'pnpm@fixture', 'dlx', 'tsx', 'script.ts',
    ])
    expect(readFileSync(join(shimRoot, 'npm.cmd'), 'utf8')).toContain('"pnpm@fixture" %*')
    expect(readFileSync(join(shimRoot, 'npx.cmd'), 'utf8')).toContain('"pnpm@fixture" "dlx" %*')
    expect(readFileSync(join(shimRoot, 'pnpm.cmd'), 'utf8')).toContain('"pnpm@fixture" %*')
  })

  it('runs an npm-named nested package script through real pinned pnpm', () => {
    const corepack = resolve('.build/stage/runtime-tools/corepack/dist/corepack.js')
    if (!existsSync(corepack)) return
    const root = mkdtempSync(join(tmpdir(), 'dsh-app-real-package-shims-'))
    fixtures.push(root)
    const shimRoot = join(root, 'pnpm-home')
    const marker = join(root, 'nested-script-ran')
    writeFileSync(join(root, 'inner.mjs'), [
      "import { writeFileSync } from 'node:fs'",
      `writeFileSync(${JSON.stringify(marker)}, 'pnpm')`,
      '',
    ].join('\n'))
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'npm-shim-real-fixture',
      private: true,
      scripts: {
        outer: 'npm run inner',
        inner: 'node inner.mjs',
      },
    }))
    writeNpmCompatibilityShims({
      directory: shimRoot,
      nodeExecutable: process.execPath,
      corepack,
    })

    execFileSync(process.execPath, [corepack, 'pnpm@11.7.0', 'run', 'outer'], {
      cwd: root,
      env: { ...process.env, PATH: `${shimRoot}${delimiter}${process.env.PATH ?? ''}` },
      stdio: 'pipe',
    })
    expect(readFileSync(marker, 'utf8')).toBe('pnpm')
  })
})

function executeShim(shimRoot: string, name: string, args: string[], capture: string): void {
  const env = { ...process.env, SHIM_CAPTURE: capture }
  if (process.platform !== 'win32') {
    execFileSync(join(shimRoot, name), args, { env })
    return
  }

  const shim = join(shimRoot, `${name}.cmd`).replaceAll('"', '""')
  const command = `""${shim}" ${args.map(cmdArgument).join(' ')}"`
  execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command], { env })
}

function cmdArgument(value: string): string {
  return `"${value.replaceAll('%', '%%').replaceAll('"', '""')}"`
}
