export type ErrorDetail = {
  label: string
  value: string
}

export type LaunchError = {
  code: string
  title: string
  message: string
  details: ErrorDetail[]
}

export type LaunchStatus =
  | { state: 'starting'; message: string }
  | { state: 'ready'; url: string }
  | { state: 'failed'; error: LaunchError }

export type BootstrapInfo = {
  edition: 'bundled' | 'lite'
  appVersion: string
  dshVersion: string
  dshCommit: string
  userRoot: string
  requiredNode: string
}

function structuredLaunchError(error: unknown): LaunchError | null {
  if (typeof error !== 'object' || error === null) return null
  const value = error as Partial<LaunchError>
  if (
    typeof value.code !== 'string'
    || typeof value.title !== 'string'
    || typeof value.message !== 'string'
    || !Array.isArray(value.details)
  ) return null
  const details = value.details.filter((detail): detail is ErrorDetail => (
    typeof detail === 'object'
    && detail !== null
    && typeof detail.label === 'string'
    && typeof detail.value === 'string'
  ))
  return { code: value.code, title: value.title, message: value.message, details }
}

export function toLaunchError(error: unknown, title: string): LaunchError {
  const direct = structuredLaunchError(error)
  if (direct) return direct
  if (typeof error === 'string') {
    try {
      const parsed = structuredLaunchError(JSON.parse(error))
      if (parsed) return parsed
    } catch {
      // Tauri may reject with a plain message rather than serialized error data.
    }
  }
  return {
    code: 'APP_BRIDGE_FAILED',
    title,
    message: error instanceof Error ? error.message : String(error),
    details: [],
  }
}
