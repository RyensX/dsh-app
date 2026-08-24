import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertDshBranch,
  createDshBuildWorktree,
  hasDshUpdate,
  isDshReleaseCurrent,
  latestDshRelease,
  parseDshRemoteHead,
  parseDshRemoteTags,
  readDshSubmoduleRepository,
  removeDshBuildWorktree,
  validateDshRepository,
} from '../scripts/lib/dsh-git.mjs'

const fixtures: string[] = []
const commitA = 'a'.repeat(40)
const commitB = 'b'.repeat(40)
const tagObject = 'c'.repeat(40)

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true })
})

describe('dsh Git source contract', () => {
  it('reads the runtime repository from the dsh submodule declaration', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-app-gitmodules-'))
    fixtures.push(root)
    writeFileSync(join(root, '.gitmodules'), [
      '[submodule "dsh"]',
      '\tpath = dsh',
      '\turl = https://github.com/example/runtime.git',
      '',
    ].join('\n'))

    expect(readDshSubmoduleRepository(root)).toBe('https://github.com/example/runtime.git')
  })

  it('accepts only absolute credential-free HTTPS repository URLs', () => {
    expect(validateDshRepository('https://github.com/deepseek-ai/deepseek-harness.git'))
      .toBe('https://github.com/deepseek-ai/deepseek-harness.git')
    expect(() => validateDshRepository('https://user@example.com/owner/repository.git')).toThrow()
    expect(() => validateDshRepository('../relative/repository.git')).toThrow()
  })

  it('peels annotated tags and selects the newest semantic dsh tag', () => {
    const releases = parseDshRemoteTags([
      `${commitA}\trefs/tags/dsh-v0.1.0-rc.9`,
      `${tagObject}\trefs/tags/dsh-v0.1.0-rc.10`,
      `${commitB}\trefs/tags/dsh-v0.1.0-rc.10^{}`,
      `${'d'.repeat(40)}\trefs/tags/not-a-dsh-release`,
    ].join('\n'))

    expect(latestDshRelease(releases)).toEqual({
      tag: 'dsh-v0.1.0-rc.10',
      version: '0.1.0-rc.10',
      commit: commitB,
    })
  })

  it('decides update availability only from commit identity', () => {
    expect(hasDshUpdate(commitA, commitA)).toBe(false)
    expect(hasDshUpdate(commitA, commitB)).toBe(true)
  })

  it('resolves the latest channel from the upstream default branch HEAD', () => {
    expect(parseDshRemoteHead([
      'ref: refs/heads/main\tHEAD',
      `${commitB}\tHEAD`,
    ].join('\n'))).toEqual({ branch: 'main', commit: commitB })
    expect(() => parseDshRemoteHead(`${commitB}\tHEAD`)).toThrow('does not resolve')
    expect(() => assertDshBranch('../main')).toThrow('invalid dsh branch')
    expect(() => assertDshBranch('-main')).toThrow('invalid dsh branch')
  })

  it('reports fully up to date only when both commit and tag match', () => {
    expect(isDshReleaseCurrent(commitA, 'dsh-v0.1.0-rc.8', commitA, 'dsh-v0.1.0-rc.8')).toBe(true)
    expect(isDshReleaseCurrent(commitA, null, commitA, 'dsh-v0.1.0-rc.8')).toBe(false)
    expect(isDshReleaseCurrent(commitA, 'dsh-v0.1.0-rc.8', commitB, 'dsh-v0.1.0-rc.8')).toBe(false)
  })

  it('builds in a detached worktree without modifying the persistent source', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-app-worktree-'))
    fixtures.push(root)
    const sourceRoot = join(root, 'source')
    const buildRoot = join(root, 'staging/build/source')
    mkdirSync(sourceRoot, { recursive: true })
    execFileSync('git', ['init', '--quiet'], { cwd: sourceRoot })
    execFileSync('git', ['config', 'user.name', 'DSH App Test'], { cwd: sourceRoot })
    execFileSync('git', ['config', 'user.email', 'dsh-app-test@example.invalid'], { cwd: sourceRoot })
    writeFileSync(join(sourceRoot, 'client.js'), 'export const version = "persistent"\n')
    execFileSync('git', ['add', 'client.js'], { cwd: sourceRoot })
    execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: sourceRoot })
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim()

    const worktree = createDshBuildWorktree({ sourceRoot, commit, destination: buildRoot })
    writeFileSync(join(worktree, 'client.js'), 'export const version = "build"\n')

    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim()).toBe(commit)
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: sourceRoot, encoding: 'utf8' })).toBe('')
    expect(execFileSync('git', ['show', 'HEAD:client.js'], { cwd: sourceRoot, encoding: 'utf8' }))
      .toBe('export const version = "persistent"\n')

    removeDshBuildWorktree({ sourceRoot, destination: worktree })
    expect(existsSync(buildRoot)).toBe(false)
  })
})
