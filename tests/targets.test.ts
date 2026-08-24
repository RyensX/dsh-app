import { describe, expect, it } from 'vitest'
import { targetInfo } from '../scripts/lib/targets.mjs'

describe('release target mapping', () => {
  it('maps every supported desktop target to the official Node archive', () => {
    expect(targetInfo('aarch64-apple-darwin').nodeArchive('24.19.0'))
      .toBe('node-v24.19.0-darwin-arm64.tar.gz')
    expect(targetInfo('x86_64-apple-darwin').nodeArchive('24.19.0'))
      .toBe('node-v24.19.0-darwin-x64.tar.gz')
    expect(targetInfo('x86_64-pc-windows-msvc').nodeArchive('24.19.0'))
      .toBe('node-v24.19.0-win-x64.zip')
  })

  it('rejects unsupported targets', () => {
    expect(() => targetInfo('aarch64-linux-android')).toThrow(/unsupported target triple/u)
  })
})
