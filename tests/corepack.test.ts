import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { resolveCorepackEntry, runCorepack } from '../scripts/lib/corepack.mjs'

describe('Corepack process launcher', () => {
  it('uses the JavaScript entrypoint instead of a platform shell shim', () => {
    expect(existsSync(resolveCorepackEntry())).toBe(true)
    expect(runCorepack(['pnpm@11.7.0', '--version'], { capture: true })).toBe('11.7.0')
  })
})
