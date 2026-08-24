import {
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { resolve } from 'node:path'
import { parseDocument, stringify } from 'yaml'

export const FLAT_CREDENTIALS_LAYOUT = 'flat-v0'
export const VERSIONED_CREDENTIALS_LAYOUT = 'versioned-v1'

const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u

export function detectDshCredentialsLayout(sourceRoot) {
  const implementation = readFileSync(
    resolve(sourceRoot, 'packages/credentials/credentials-local/src/index.ts'),
    'utf8',
  )
  const hasVersionOne = /export const DOCUMENT_VERSION\s*=\s*1\b/u.test(implementation)
  if (hasVersionOne && implementation.includes('export function parseCredentialsDocument')) {
    return VERSIONED_CREDENTIALS_LAYOUT
  }
  if (!implementation.includes('DOCUMENT_VERSION') && implementation.includes('export function parseCredentialsDocument')) {
    return FLAT_CREDENTIALS_LAYOUT
  }
  throw new Error('unsupported dsh credentials document layout')
}

export function prepareCredentialsProfile({ profileRoot, targetLayout, backupSuffix = timestampSuffix() }) {
  if (targetLayout === VERSIONED_CREDENTIALS_LAYOUT) {
    return { changed: false, backupPath: null }
  }
  if (targetLayout !== FLAT_CREDENTIALS_LAYOUT) {
    throw new Error(`unsupported restore credentials layout: ${targetLayout}`)
  }

  const credentialsPath = resolve(profileRoot, '.credentials.yaml')
  if (!existsSync(credentialsPath)) return { changed: false, backupPath: null }
  const original = readFileSync(credentialsPath, 'utf8')
  const flattened = flattenVersionOneDocument(original, credentialsPath)
  if (flattened === null) return { changed: false, backupPath: null }

  const backupPath = uniqueBackupPath(credentialsPath, backupSuffix)
  copyFileSync(credentialsPath, backupPath, fsConstants.COPYFILE_EXCL)
  chmodSync(backupPath, 0o600)

  const temporary = `${credentialsPath}.restore-${process.pid}`
  try {
    writeFileSync(temporary, flattened, { flag: 'wx', mode: 0o600 })
    renameSync(temporary, credentialsPath)
  } finally {
    rmSync(temporary, { force: true })
  }
  return { changed: true, backupPath }
}

function flattenVersionOneDocument(text, filename) {
  const document = parseDocument(text, { prettyErrors: false, uniqueKeys: true })
  if (document.errors.length > 0) {
    throw new Error(`cannot safely prepare invalid credentials document: ${filename}`)
  }
  const root = document.toJS() ?? {}
  if (!isMapping(root)) {
    throw new Error(`cannot safely prepare non-mapping credentials document: ${filename}`)
  }
  const fields = root
  const keys = Object.keys(fields)
  if (keys.length === 0) return null

  if (!Object.hasOwn(fields, 'version')) {
    assertFlatEntries(fields, filename)
    return null
  }
  if (fields.version !== 1) {
    throw new Error('cannot restore an unsupported credentials document version')
  }
  for (const key of keys) {
    if (key !== 'version' && key !== 'refs' && key !== 'records') {
      throw new Error(`cannot safely prepare credentials document with field ${key}`)
    }
  }

  const records = fields.records ?? {}
  if (!isMapping(records) || Object.keys(records).length > 0) {
    throw new Error('cannot restore the legacy runtime without dropping structured credential records')
  }
  const refs = fields.refs ?? {}
  if (!isMapping(refs)) {
    throw new Error(`cannot safely prepare non-mapping credential refs: ${filename}`)
  }
  assertFlatEntries(refs, filename)
  return Object.keys(refs).length === 0 ? '{}\n' : stringify(refs, { lineWidth: 0 })
}

function assertFlatEntries(value, filename) {
  for (const [key, secret] of Object.entries(value)) {
    if (!CREDENTIAL_REF_PATTERN.test(key)) {
      throw new Error(`cannot safely prepare invalid credential reference ${key}`)
    }
    if (typeof secret !== 'string' || secret.length === 0) {
      // 只报告引用名，绝不把凭据值带进日志。
      throw new Error(`cannot safely prepare non-string credential reference ${key} in ${filename}`)
    }
  }
}

function isMapping(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function uniqueBackupPath(credentialsPath, suffix) {
  for (let index = 0; index < 100; index += 1) {
    const discriminator = index === 0 ? '' : `-${index}`
    const candidate = `${credentialsPath}.before-restore-${suffix}${discriminator}`
    if (!existsSync(candidate)) return candidate
  }
  throw new Error('could not allocate a credentials restore backup path')
}

function timestampSuffix() {
  return new Date().toISOString().replace(/[^0-9]/gu, '').slice(0, 14)
}
