import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bootstrapAction } from '../src/shared/bootstrap'
import { toLaunchError } from '../src/shared/contracts'

function textFiles(root: string): string {
  if (!existsSync(root)) return ''
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => readFileSync(join(entry.parentPath, entry.name), 'utf8'))
    .join('\n')
}

describe('frontend edition isolation', () => {
  it('keeps Lite Node controls out of the Bundled build', () => {
    const bundled = textFiles(resolve('dist/bundled'))
    const lite = textFiles(resolve('dist/lite'))
    if (!bundled || !lite) return
    expect(bundled).not.toContain('Choose Node')
    expect(bundled).not.toContain('NODE_NOT_FOUND')
    expect(lite).toContain('Choose Node')
    expect(lite).toContain('Use Bundled')
    expect(bundled).toContain('Open data directory')
    expect(lite).toContain('Open data directory')
  })

  it('opens the App-resolved data root without accepting a browser path', () => {
    const bridge = readFileSync(resolve('src/shared/bridge.ts'), 'utf8')
    const app = readFileSync(resolve('src-tauri/src/app.rs'), 'utf8')
    const native = readFileSync(resolve('src-tauri/src/lib.rs'), 'utf8')
    expect(bridge).toContain("invoke('open_data_directory')")
    expect(app).toContain('pub fn open_data_directory(app: AppHandle)')
    expect(app).toContain('open::that_detached(&dirs.root)')
    expect(native.match(/app::open_data_directory/g)).toHaveLength(2)
  })

  it('does not automatically restart after dsh reports a failure', () => {
    expect(bootstrapAction({
      state: 'failed',
      error: { code: 'DSH_EXITED', title: 'Stopped', message: 'Retry manually', details: [] },
    })).toBe('wait')
    expect(bootstrapAction({ state: 'starting', message: 'First launch' })).toBe('start')
    expect(bootstrapAction({ state: 'ready', url: 'http://127.0.0.1:12345' })).toBe('navigate')
  })

  it('preserves structured launch diagnostics returned by Tauri', () => {
    const error = toLaunchError({
      code: 'USER_DATA_DIR_NOT_WRITABLE',
      title: 'Data directory unavailable',
      message: 'Check permissions',
      details: [{ label: 'Path', value: '/profile' }],
    }, 'Fallback')
    expect(error.code).toBe('USER_DATA_DIR_NOT_WRITABLE')
    expect(error.details).toEqual([{ label: 'Path', value: '/profile' }])
  })
})
