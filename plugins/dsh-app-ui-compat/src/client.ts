import {
  parseMacOSWindowChromeGeometry,
  parsePageZoom,
  resolveCollapsedSidebarGeometry,
  resolveTopPadding,
} from './geometry.ts'

const COLLAPSED_CONTROL_WIDTH = 36
const EXPANDED_BASE_TOP_PADDING = 6
const COLLAPSED_BASE_TOP_PADDING = 18
const NATIVE_CONTENT_TOP_GAP = 2
const FRAME_ATTRIBUTE = 'data-dsh-app-ui-compat-frame'
const SYNC_ATTRIBUTE = 'data-dsh-app-ui-compat-syncing'
const NATIVE_GEOMETRY_EVENT = 'dsh-app:macos-window-chrome'
const NATIVE_GEOMETRY_GLOBAL = '__DSH_APP_MACOS_WINDOW_CHROME__'
const DETAILS_WIDTH_PROPERTY = '--dsh-app-ui-compat-details-width'
const COLLAPSED_WIDTH_PROPERTY = '--dsh-app-ui-compat-collapsed-width'
const COLLAPSED_PADDING_PROPERTY = '--dsh-app-ui-compat-collapsed-inline-padding'
const EXPANDED_TOP_PROPERTY = '--dsh-app-ui-compat-expanded-top-padding'
const COLLAPSED_TOP_PROPERTY = '--dsh-app-ui-compat-collapsed-top-padding'
const STYLE_ID = 'dsh-app-ui-compat-style'
const GRID_TRACKS = /^\s*(\d+(?:\.\d+)?)px\s+minmax\(0(?:px)?,\s*1fr\)\s+(\d+(?:\.\d+)?)px\s*$/
const OWNED_PROPERTIES = [
  DETAILS_WIDTH_PROPERTY,
  COLLAPSED_WIDTH_PROPERTY,
  COLLAPSED_PADDING_PROPERTY,
  EXPANDED_TOP_PROPERTY,
  COLLAPSED_TOP_PROPERTY,
] as const

interface ClientContext {
  effect(setup: () => (() => void), label: string): void
}

type NativeGeometryWindow = Window & {
  [NATIVE_GEOMETRY_GLOBAL]?: unknown
}

function cssPixels(value: number): string {
  return `${Math.round(value * 1000) / 1000}px`
}

function setStyleProperty(element: HTMLElement, property: string, value: string): void {
  if (element.style.getPropertyValue(property) === value) return
  element.style.setProperty(property, value)
}

function currentPageZoom(): number {
  const root = document.documentElement
  const computed = getComputedStyle(root).getPropertyValue('zoom')
  return parsePageZoom(computed || root.style.getPropertyValue('zoom'))
}

function clearFrame(element: HTMLElement): void {
  element.removeAttribute(FRAME_ATTRIBUTE)
  element.removeAttribute(SYNC_ATTRIBUTE)
  for (const property of OWNED_PROPERTIES) element.style.removeProperty(property)
}

function install(): () => void {
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.dataset.plugin = 'dsh-app-ui-compat'
  style.textContent = `
    [${FRAME_ATTRIBUTE}][${SYNC_ATTRIBUTE}] {
      transition: none !important;
    }

    [${FRAME_ATTRIBUTE}] > :first-child [data-slot="sidebar"] > :first-child {
      padding-top: var(${EXPANDED_TOP_PROPERTY}) !important;
    }

    [${FRAME_ATTRIBUTE}][data-sidebar-collapsed] {
      grid-template-columns: var(${COLLAPSED_WIDTH_PROPERTY}) minmax(0, 1fr) var(${DETAILS_WIDTH_PROPERTY}, 0px) !important;
    }

    [${FRAME_ATTRIBUTE}][data-sidebar-collapsed] > :first-child [data-slot="sidebar"] > :first-child {
      padding-top: var(${COLLAPSED_TOP_PROPERTY}) !important;
      padding-right: var(${COLLAPSED_PADDING_PROPERTY}) !important;
      padding-left: var(${COLLAPSED_PADDING_PROPERTY}) !important;
    }
  `
  ;(document.head ?? document.documentElement).append(style)

  const nativeWindow = window as NativeGeometryWindow
  let nativeGeometry = parseMacOSWindowChromeGeometry(nativeWindow[NATIVE_GEOMETRY_GLOBAL])
  let active = true
  const transitionFrames = new Map<HTMLElement, number>()

  const suppressTrackTransition = (frame: HTMLElement): void => {
    frame.setAttribute(SYNC_ATTRIBUTE, '')
    const pending = transitionFrames.get(frame)
    if (pending !== undefined) cancelAnimationFrame(pending)
    const firstFrame = requestAnimationFrame(() => {
      const secondFrame = requestAnimationFrame(() => {
        transitionFrames.delete(frame)
        if (active) frame.removeAttribute(SYNC_ATTRIBUTE)
      })
      transitionFrames.set(frame, secondFrame)
    })
    transitionFrames.set(frame, firstFrame)
  }

  const syncFrame = (element: Element, instant = false): void => {
    if (!(element instanceof HTMLElement)) return
    const tracks = GRID_TRACKS.exec(element.style.gridTemplateColumns)
    const hasOverlayLayer = Array.from(element.children).some(child => (
      child instanceof HTMLElement && child.hasAttribute('data-shell-overlay')
    ))
    if (tracks === null || !hasOverlayLayer) return
    if (nativeGeometry === undefined) {
      clearFrame(element)
      return
    }

    const baseSidebarWidth = Number(tracks[1])
    const detailsWidth = Number(tracks[2])
    const zoom = currentPageZoom()
    const collapsed = resolveCollapsedSidebarGeometry(
      baseSidebarWidth,
      COLLAPSED_CONTROL_WIDTH,
      nativeGeometry.trafficLightSafeWidth,
      zoom,
    )
    if (instant) suppressTrackTransition(element)
    setStyleProperty(element, DETAILS_WIDTH_PROPERTY, cssPixels(detailsWidth))
    setStyleProperty(element, COLLAPSED_WIDTH_PROPERTY, cssPixels(collapsed.width))
    setStyleProperty(element, COLLAPSED_PADDING_PROPERTY, cssPixels(collapsed.inlinePadding))
    setStyleProperty(element, EXPANDED_TOP_PROPERTY, cssPixels(resolveTopPadding(
      EXPANDED_BASE_TOP_PADDING,
      nativeGeometry.titlebarHeight,
      NATIVE_CONTENT_TOP_GAP,
      zoom,
    )))
    setStyleProperty(element, COLLAPSED_TOP_PROPERTY, cssPixels(resolveTopPadding(
      COLLAPSED_BASE_TOP_PADDING,
      nativeGeometry.titlebarHeight,
      NATIVE_CONTENT_TOP_GAP,
      zoom,
    )))
    element.setAttribute(FRAME_ATTRIBUTE, '')
  }

  const scan = (node: Node, instant = false): void => {
    if (!(node instanceof Element)) return
    syncFrame(node, instant)
    node.querySelectorAll('[style]').forEach(element => { syncFrame(element, instant) })
  }

  const syncAllFrames = (instant = false): void => {
    document.querySelectorAll('[style]').forEach(element => { syncFrame(element, instant) })
  }

  const onNativeGeometry = (event: Event): void => {
    const next = parseMacOSWindowChromeGeometry((event as CustomEvent<unknown>).detail)
    if (next === undefined) return
    nativeGeometry = next
    nativeWindow[NATIVE_GEOMETRY_GLOBAL] = next
    syncAllFrames(true)
  }
  window.addEventListener(NATIVE_GEOMETRY_EVENT, onNativeGeometry)

  scan(document.documentElement, true)
  const observer = new MutationObserver(records => {
    let rootZoomChanged = false
    for (const record of records) {
      if (record.type === 'attributes') {
        if (record.target === document.documentElement && record.attributeName === 'style') {
          rootZoomChanged = true
        } else {
          syncFrame(record.target as Element)
        }
      }
      for (const node of record.addedNodes) scan(node)
    }
    if (rootZoomChanged) syncAllFrames(true)
  })
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-sidebar-collapsed', 'style'],
    childList: true,
    subtree: true,
  })

  return () => {
    active = false
    observer.disconnect()
    window.removeEventListener(NATIVE_GEOMETRY_EVENT, onNativeGeometry)
    for (const animationFrame of transitionFrames.values()) cancelAnimationFrame(animationFrame)
    transitionFrames.clear()
    style.remove()
    document.querySelectorAll(`[${FRAME_ATTRIBUTE}], [${SYNC_ATTRIBUTE}]`).forEach(element => {
      if (element instanceof HTMLElement) clearFrame(element)
    })
  }
}

export function apply(ctx: ClientContext): void {
  ctx.effect(install, 'dsh-app-ui-compat: macOS native window geometry')
}
