const COLLAPSED_SIDEBAR_WIDTH = 72
const COLLAPSED_CONTROL_WIDTH = 36
const COLLAPSED_INLINE_PADDING = (COLLAPSED_SIDEBAR_WIDTH - COLLAPSED_CONTROL_WIDTH) / 2
const FRAME_ATTRIBUTE = 'data-dsh-app-ui-compat-frame'
const DETAILS_WIDTH_PROPERTY = '--dsh-app-ui-compat-details-width'
const STYLE_ID = 'dsh-app-ui-compat-style'
const GRID_TRACKS = /^\s*\d+(?:\.\d+)?px\s+minmax\(0(?:px)?,\s*1fr\)\s+(\d+(?:\.\d+)?)px\s*$/

interface ClientContext {
  effect(setup: () => (() => void), label: string): void
}

function syncFrame(element: Element): void {
  if (!(element instanceof HTMLElement)) return
  const tracks = GRID_TRACKS.exec(element.style.gridTemplateColumns)
  const hasOverlayLayer = Array.from(element.children).some(child => (
    child instanceof HTMLElement && child.hasAttribute('data-shell-overlay')
  ))
  if (tracks === null || !hasOverlayLayer) return

  element.setAttribute(FRAME_ATTRIBUTE, '')
  element.style.setProperty(DETAILS_WIDTH_PROPERTY, `${tracks[1]}px`)
}

function scan(node: Node): void {
  if (!(node instanceof Element)) return
  syncFrame(node)
  node.querySelectorAll('[style]').forEach(syncFrame)
}

function install(): () => void {
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.dataset.plugin = 'dsh-app-ui-compat'
  style.textContent = `
    [${FRAME_ATTRIBUTE}] > :first-child [data-slot="sidebar"] > :first-child {
      padding-top: 36px !important;
    }

    [${FRAME_ATTRIBUTE}][data-sidebar-collapsed] {
      grid-template-columns: ${COLLAPSED_SIDEBAR_WIDTH}px minmax(0, 1fr) var(${DETAILS_WIDTH_PROPERTY}, 0px) !important;
    }

    [${FRAME_ATTRIBUTE}][data-sidebar-collapsed] > :first-child [data-slot="sidebar"] > :first-child {
      padding-top: 48px !important;
      padding-right: ${COLLAPSED_INLINE_PADDING}px !important;
      padding-left: ${COLLAPSED_INLINE_PADDING}px !important;
    }
  `
  ;(document.head ?? document.documentElement).append(style)

  scan(document.documentElement)
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') syncFrame(record.target as Element)
      for (const node of record.addedNodes) scan(node)
    }
  })
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-sidebar-collapsed', 'style'],
    childList: true,
    subtree: true,
  })

  return () => {
    observer.disconnect()
    style.remove()
    document.querySelectorAll(`[${FRAME_ATTRIBUTE}]`).forEach(element => {
      element.removeAttribute(FRAME_ATTRIBUTE)
      if (element instanceof HTMLElement) element.style.removeProperty(DETAILS_WIDTH_PROPERTY)
    })
  }
}

export function apply(ctx: ClientContext): void {
  ctx.effect(install, 'dsh-app-ui-compat: macOS layout')
}
