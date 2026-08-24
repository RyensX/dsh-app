import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('repository layout', () => {
  it('tracks dsh as a real Git submodule', () => {
    const stage = execFileSync('git', ['ls-files', '--stage', '--', 'dsh'], { encoding: 'utf8' }).trim()
    expect(stage).toMatch(/^160000 [a-f0-9]{40} 0\tdsh$/u)

    const topLevel = execFileSync('git', ['-C', 'dsh', 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim()
    expect(realpathSync(topLevel)).toBe(realpathSync(resolve('dsh')))
  })
})
