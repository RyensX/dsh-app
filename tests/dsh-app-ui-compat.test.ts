import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  parseMacOSWindowChromeGeometry,
  parsePageZoom,
  resolveCollapsedSidebarGeometry,
  resolveTopPadding,
} from '../plugins/dsh-app-ui-compat/src/geometry.ts'

describe('macOS window chrome geometry', () => {
  it('keeps the compatibility client out of non-macOS packages', () => {
    const manifest = JSON.parse(readFileSync(resolve(
      process.cwd(),
      'plugins/dsh-app-ui-compat/dsh-app.plugin.json',
    ), 'utf8'))
    expect(manifest.targets).toEqual(['macos'])
  })

  it('accepts only finite non-negative native measurements', () => {
    expect(parseMacOSWindowChromeGeometry({
      trafficLightSafeWidth: 72,
      titlebarHeight: 28,
    })).toEqual({ trafficLightSafeWidth: 72, titlebarHeight: 28 })
    expect(parseMacOSWindowChromeGeometry({
      trafficLightSafeWidth: Number.NaN,
      titlebarHeight: 28,
    })).toBeUndefined()
    expect(parseMacOSWindowChromeGeometry({
      trafficLightSafeWidth: 72,
      titlebarHeight: -1,
    })).toBeUndefined()
  })

  it('normalizes computed and inline CSS zoom forms', () => {
    expect(parsePageZoom('0.9')).toBe(0.9)
    expect(parsePageZoom('90%')).toBe(0.9)
    expect(parsePageZoom('normal')).toBe(1)
    expect(parsePageZoom('invalid')).toBe(1)
  })

  it('preserves native clearance without shrinking below the DSH rail', () => {
    expect(resolveCollapsedSidebarGeometry(56, 36, 72, 0.5)).toEqual({
      width: 144,
      inlinePadding: 54,
    })
    expect(resolveCollapsedSidebarGeometry(56, 36, 72, 0.9)).toEqual({
      width: 80,
      inlinePadding: 22,
    })
    expect(resolveCollapsedSidebarGeometry(56, 36, 72, 1)).toEqual({
      width: 72,
      inlinePadding: 18,
    })
    expect(resolveCollapsedSidebarGeometry(56, 36, 72, 1.5)).toEqual({
      width: 56,
      inlinePadding: 10,
    })
  })

  it('counter-scales only the native titlebar inset', () => {
    expect(resolveTopPadding(6, 28, 2, 1)).toBe(36)
    expect(resolveTopPadding(18, 28, 2, 0.5)).toBe(78)
    expect(resolveTopPadding(18, 0, 2, 0.5)).toBe(18)
  })
})
