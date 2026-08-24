import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  detectDshCredentialsLayout,
  FLAT_CREDENTIALS_LAYOUT,
  prepareCredentialsProfile,
  VERSIONED_CREDENTIALS_LAYOUT,
} from '../scripts/lib/credentials-profile.mjs'

const fixtures: string[] = []

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true })
})

describe('restore credentials compatibility', () => {
  it('backs up and flattens the recognized version-one refs document', () => {
    const profileRoot = fixture()
    const credentials = join(profileRoot, '.credentials.yaml')
    const original = [
      'version: 1',
      'refs:',
      '  FIRST_API_KEY: secret-one',
      '  SECOND_TOKEN: "secret: two"',
      '',
    ].join('\n')
    writeFileSync(credentials, original, { mode: 0o600 })
    chmodSync(credentials, 0o600)

    const prepared = prepareCredentialsProfile({
      profileRoot,
      targetLayout: FLAT_CREDENTIALS_LAYOUT,
      backupSuffix: 'fixture',
    })

    expect(prepared.changed).toBe(true)
    expect(prepared.backupPath).toBe(`${credentials}.before-restore-fixture`)
    expect(readFileSync(prepared.backupPath!, 'utf8')).toBe(original)
    // Windows 依赖用户目录继承 ACL，不提供可比较的 POSIX mode bits。
    if (process.platform !== 'win32') {
      expect(statSync(prepared.backupPath!).mode & 0o777).toBe(0o600)
    }
    expect(readFileSync(credentials, 'utf8')).toBe([
      'FIRST_API_KEY: secret-one',
      'SECOND_TOKEN: "secret: two"',
      '',
    ].join('\n'))

    expect(prepareCredentialsProfile({
      profileRoot,
      targetLayout: FLAT_CREDENTIALS_LAYOUT,
      backupSuffix: 'second',
    })).toEqual({ changed: false, backupPath: null })
    expect(existsSync(`${credentials}.before-restore-second`)).toBe(false)
  })

  it('refuses to discard structured credential records', () => {
    const profileRoot = fixture()
    const credentials = join(profileRoot, '.credentials.yaml')
    const original = [
      'version: 1',
      'refs: {}',
      'records:',
      '  account:',
      '    type: bearer',
      '    token: secret',
      '',
    ].join('\n')
    writeFileSync(credentials, original, { mode: 0o600 })

    expect(() => prepareCredentialsProfile({
      profileRoot,
      targetLayout: FLAT_CREDENTIALS_LAYOUT,
      backupSuffix: 'fixture',
    })).toThrow('without dropping structured credential records')
    expect(readFileSync(credentials, 'utf8')).toBe(original)
    expect(existsSync(`${credentials}.before-restore-fixture`)).toBe(false)
  })

  it('does not alter credentials for a versioned restore target', () => {
    const profileRoot = fixture()
    const credentials = join(profileRoot, '.credentials.yaml')
    writeFileSync(credentials, 'version: 1\nrefs: {}\n', { mode: 0o600 })

    expect(prepareCredentialsProfile({
      profileRoot,
      targetLayout: VERSIONED_CREDENTIALS_LAYOUT,
    })).toEqual({ changed: false, backupPath: null })
  })

  it('detects flat and version-one dsh source layouts', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-app-credentials-layout-'))
    fixtures.push(root)
    const source = join(root, 'packages/credentials/credentials-local/src')
    mkdirSync(source, { recursive: true })
    const implementation = join(source, 'index.ts')
    writeFileSync(implementation, 'export function parseCredentialsDocument() {}\n')
    expect(detectDshCredentialsLayout(root)).toBe(FLAT_CREDENTIALS_LAYOUT)

    writeFileSync(implementation, [
      'export const DOCUMENT_VERSION = 1',
      'export function parseCredentialsDocument() {}',
      'export function renderFlatLayoutMigration() {}',
      '',
    ].join('\n'))
    expect(detectDshCredentialsLayout(root)).toBe(VERSIONED_CREDENTIALS_LAYOUT)
  })
})

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-app-credentials-profile-'))
  fixtures.push(root)
  return root
}
