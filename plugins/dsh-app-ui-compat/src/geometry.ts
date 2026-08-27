export interface MacOSWindowChromeGeometry {
  /** macOS 窗口左边缘到原生窗口按钮安全区右边缘的逻辑点宽度。 */
  trafficLightSafeWidth: number
  /** 覆盖在 WebView 顶部的原生标题栏高度，单位为逻辑点。 */
  titlebarHeight: number
}

export interface CollapsedSidebarGeometry {
  width: number
  inlinePadding: number
}

function nonNegativeFinite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

/** 校验原生层下发的只读窗口几何，拒绝页面内伪造的异常数值。 */
export function parseMacOSWindowChromeGeometry(value: unknown): MacOSWindowChromeGeometry | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const source = value as Record<string, unknown>
  const trafficLightSafeWidth = nonNegativeFinite(source.trafficLightSafeWidth)
  const titlebarHeight = nonNegativeFinite(source.titlebarHeight)
  if (trafficLightSafeWidth === undefined || titlebarHeight === undefined) return undefined
  return { trafficLightSafeWidth, titlebarHeight }
}

/** 把 CSS `zoom` 的百分比或数值表示规范成正数倍率。 */
export function parsePageZoom(value: string): number {
  const normalized = value.trim()
  if (normalized === '' || normalized === 'normal') return 1
  const percentage = normalized.endsWith('%')
  const numeric = Number(percentage ? normalized.slice(0, -1) : normalized)
  const zoom = percentage ? numeric / 100 : numeric
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1
}

/**
 * 原生安全宽度保持为窗口逻辑点，同时不把 DSH 自身的收起栏压得比原始宽度更窄。
 */
export function resolveCollapsedSidebarGeometry(
  baseWidth: number,
  controlWidth: number,
  trafficLightSafeWidth: number,
  pageZoom: number,
): CollapsedSidebarGeometry {
  const safeBaseWidth = finiteOrZero(baseWidth)
  const safeControlWidth = finiteOrZero(controlWidth)
  const safeNativeWidth = finiteOrZero(trafficLightSafeWidth)
  const safeZoom = Number.isFinite(pageZoom) && pageZoom > 0 ? pageZoom : 1
  const width = Math.max(safeBaseWidth, safeNativeWidth / safeZoom)
  return {
    width,
    inlinePadding: Math.max(0, (width - safeControlWidth) / 2),
  }
}

/** 原生标题栏不随页面缩放；只对原生占位做逆缩放，DSH 自身留白仍跟随页面。 */
export function resolveTopPadding(
  basePadding: number,
  titlebarHeight: number,
  nativeContentGap: number,
  pageZoom: number,
): number {
  const safeBasePadding = finiteOrZero(basePadding)
  const safeTitlebarHeight = finiteOrZero(titlebarHeight)
  if (safeTitlebarHeight === 0) return safeBasePadding
  const safeGap = finiteOrZero(nativeContentGap)
  const safeZoom = Number.isFinite(pageZoom) && pageZoom > 0 ? pageZoom : 1
  return safeBasePadding + (safeTitlebarHeight + safeGap) / safeZoom
}
