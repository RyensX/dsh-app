import { describe, expect, it } from 'vitest'
import { managedRuntimeInstallArgs } from '../scripts/lib/runtime-manager-command.mjs'

const required = {
  runtimeManager: '/stage/runtime-tools/dsh-runtime-manager.mjs',
  bootstrapPath: '/stage/bootstrap-manifest.json',
  userRuntime: '/user/runtime',
  pluginPayload: '/stage/plugin-payload',
  corepack: '/stage/runtime-tools/corepack/dist/corepack.js',
  commit: 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e',
}

describe('managed runtime install command', () => {
  it('omits an unavailable tag and installs the exact commit', () => {
    const args = managedRuntimeInstallArgs({ ...required, tag: null })

    expect(args).toContain(required.commit)
    expect(args).not.toContain('--tag')
    expect(args).not.toContain(null)
    expect(args.slice(-2)).toEqual(['--activation', 'current'])
  })

  it('passes a known tag with the exact commit', () => {
    const args = managedRuntimeInstallArgs({ ...required, tag: 'dsh-v0.1.1-rc.2' })

    expect(args).toContain(required.commit)
    expect(args.slice(-4)).toEqual(['--tag', 'dsh-v0.1.1-rc.2', '--activation', 'current'])
  })
})
