import { describe, expect, it } from 'vitest'
import { nodeDistributionLayout } from '../scripts/lib/node-download.mjs'
import { targetInfo } from '../scripts/lib/targets.mjs'

describe('Node distribution layout', () => {
  it('uses the Windows ZIP layout for the Windows target', () => {
    expect(nodeDistributionLayout(targetInfo('x86_64-pc-windows-msvc'))).toEqual({
      nodeExecutable: 'node.exe',
      corepack: 'node_modules/corepack',
      sidecarSuffix: '.exe',
    })
  })

  it('uses the Unix archive layout for macOS targets', () => {
    expect(nodeDistributionLayout(targetInfo('aarch64-apple-darwin'))).toEqual({
      nodeExecutable: 'bin/node',
      corepack: 'lib/node_modules/corepack',
      sidecarSuffix: '',
    })
    expect(nodeDistributionLayout(targetInfo('x86_64-apple-darwin'))).toEqual({
      nodeExecutable: 'bin/node',
      corepack: 'lib/node_modules/corepack',
      sidecarSuffix: '',
    })
  })
})
