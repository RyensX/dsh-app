import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export function parseFormal(value) {
  const normalized = value ?? 'false'
  if (!['true', 'false'].includes(normalized)) {
    throw new Error('--formal must be true or false')
  }
  return normalized === 'true'
}

export function readSigningOverlay(path) {
  if (!path) return null
  const absolute = resolve(path)
  if (!existsSync(absolute)) throw new Error(`signing config does not exist: ${absolute}`)
  let value
  try {
    value = JSON.parse(readFileSync(absolute, 'utf8'))
  } catch (error) {
    throw new Error(`signing config is not valid JSON: ${absolute}`, { cause: error })
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`signing config must contain a JSON object: ${absolute}`)
  }
  return value
}

export function validateFormalSigning({ formal, appTarget, environment, signingOverlay }) {
  if (!formal) return
  if (appTarget === 'macos') {
    const certificateReady = configured(environment.APPLE_CERTIFICATE)
      && configured(environment.APPLE_CERTIFICATE_PASSWORD)
      && configured(environment.APPLE_SIGNING_IDENTITY)
    const appleIdReady = configured(environment.APPLE_ID)
      && configured(environment.APPLE_PASSWORD)
      && configured(environment.APPLE_TEAM_ID)
    const apiKeyReady = configured(environment.APPLE_API_KEY)
      && configured(environment.APPLE_API_ISSUER)
      && configured(environment.APPLE_API_KEY_PATH)
      && existsSync(resolve(environment.APPLE_API_KEY_PATH))
    if (!certificateReady || (!appleIdReady && !apiKeyReady)) {
      throw new Error('formal macOS builds require Developer ID signing and notarization credentials')
    }
    return
  }

  if (appTarget === 'windows') {
    const windows = signingOverlay?.bundle?.windows
    const certificateReady = configured(windows?.certificateThumbprint)
      && configured(windows?.digestAlgorithm)
      && validTimestampUrl(windows?.timestampUrl)
    const signCommandReady = configured(windows?.signCommand) && windows.signCommand.includes('%1')
    if (!certificateReady && !signCommandReady) {
      throw new Error(
        'formal Windows builds require certificateThumbprint/digestAlgorithm/timestampUrl or a signCommand containing %1',
      )
    }
  }
}

function configured(value) {
  return typeof value === 'string'
    && value.trim().length > 0
    && !value.includes('REPLACE_WITH_')
}

function validTimestampUrl(value) {
  if (!configured(value)) return false
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}
