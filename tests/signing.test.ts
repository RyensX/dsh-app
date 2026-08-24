import { describe, expect, it } from 'vitest'
import { parseFormal, validateFormalSigning } from '../scripts/lib/signing.mjs'

describe('formal release signing gate', () => {
  it('accepts only explicit boolean strings', () => {
    expect(parseFormal(undefined)).toBe(false)
    expect(parseFormal('true')).toBe(true)
    expect(parseFormal('false')).toBe(false)
    expect(() => parseFormal('yes')).toThrow(/true or false/u)
  })

  it('requires both signing and notarization credentials on macOS', () => {
    expect(() => validateFormalSigning({
      formal: true,
      appTarget: 'macos',
      environment: {},
      signingOverlay: null,
    })).toThrow(/Developer ID signing and notarization/u)

    expect(() => validateFormalSigning({
      formal: true,
      appTarget: 'macos',
      environment: {
        APPLE_CERTIFICATE: 'base64-certificate',
        APPLE_CERTIFICATE_PASSWORD: 'password',
        APPLE_SIGNING_IDENTITY: 'Developer ID Application: Example',
        APPLE_ID: 'developer@example.com',
        APPLE_PASSWORD: 'app-password',
        APPLE_TEAM_ID: 'TEAMID',
      },
      signingOverlay: null,
    })).not.toThrow()
  })

  it('rejects an empty or placeholder Windows certificate overlay', () => {
    for (const signingOverlay of [
      null,
      {},
      {
        bundle: {
          windows: {
            certificateThumbprint: 'REPLACE_WITH_CERTIFICATE_THUMBPRINT',
            digestAlgorithm: 'sha256',
            timestampUrl: 'REPLACE_WITH_CERTIFICATE_TIMESTAMP_URL',
          },
        },
      },
    ]) {
      expect(() => validateFormalSigning({
        formal: true,
        appTarget: 'windows',
        environment: {},
        signingOverlay,
      })).toThrow(/formal Windows builds require/u)
    }
  })

  it('accepts a complete Windows certificate overlay', () => {
    expect(() => validateFormalSigning({
      formal: true,
      appTarget: 'windows',
      environment: {},
      signingOverlay: {
        bundle: {
          windows: {
            certificateThumbprint: 'A1B1A2B2A3B3A4B4A5B5A6B6A7B7A8B8A9B9A0B0',
            digestAlgorithm: 'sha256',
            timestampUrl: 'https://timestamp.example.com',
          },
        },
      },
    })).not.toThrow()
  })

  it('requires the Tauri file placeholder in a custom sign command', () => {
    const overlay = (signCommand: string) => ({ bundle: { windows: { signCommand } } })
    expect(() => validateFormalSigning({
      formal: true,
      appTarget: 'windows',
      environment: {},
      signingOverlay: overlay('sign-tool'),
    })).toThrow(/containing %1/u)
    expect(() => validateFormalSigning({
      formal: true,
      appTarget: 'windows',
      environment: {},
      signingOverlay: overlay('sign-tool %1'),
    })).not.toThrow()
  })
})
