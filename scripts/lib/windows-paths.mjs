import { readdirSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'

// Win32 MAX_PATH 的 260 包含结尾 NUL，因此可写路径本身最多 259 个 UTF-16 code unit。
export const WINDOWS_MAX_PATH_LENGTH = 259
export const WINDOWS_PROFILE_COMPONENT_BUDGET = 40
export const WINDOWS_PRODUCT_NAME = 'DSH App'
export const WINDOWS_RESOURCE_DESTINATION = 'r'

export function windowsDefaultInstallRoot({
  profileComponentLength = WINDOWS_PROFILE_COMPONENT_BUDGET,
  productName = WINDOWS_PRODUCT_NAME,
} = {}) {
  if (!Number.isInteger(profileComponentLength) || profileComponentLength < 1) {
    throw new Error(`invalid Windows profile component length: ${String(profileComponentLength)}`)
  }
  return `C:\\Users\\${'u'.repeat(profileComponentLength)}\\AppData\\Local\\${productName}`
}

// NSIS hook 使用同一上限；默认目录即使用户目录名达到 40 个字符也仍可安装。
export const WINDOWS_INSTALL_DIR_LENGTH_BUDGET = windowsDefaultInstallRoot().length

export function collectWindowsResourceInstallPaths(
  resourceRoot,
  destination = WINDOWS_RESOURCE_DESTINATION,
) {
  const root = resolve(resourceRoot)
  const paths = []
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      const resourcePath = relative(root, path).split(sep).join('\\')
      paths.push(`${destination}\\${resourcePath}`)
      if (entry.isDirectory()) visit(path)
    }
  }
  visit(root)
  return paths
}

export function assertWindowsInstallPathBudget(paths, {
  installRoot = windowsDefaultInstallRoot(),
  maxPathLength = WINDOWS_MAX_PATH_LENGTH,
} = {}) {
  if (!Number.isInteger(maxPathLength) || maxPathLength < 1) {
    throw new Error(`invalid Windows path length budget: ${String(maxPathLength)}`)
  }
  const checked = [...new Set(paths.map(normalizedWindowsRelativePath))]
    .map(path => ({ path, fullPath: `${installRoot}\\${path}` }))
    .sort((left, right) => (
      right.fullPath.length - left.fullPath.length
      || left.fullPath.localeCompare(right.fullPath)
    ))
  const longest = checked[0] ?? { path: '', fullPath: installRoot }
  if (longest.fullPath.length > maxPathLength) {
    throw new Error(
      `Windows installer path exceeds ${maxPathLength} characters `
      + `(${longest.fullPath.length}): ${longest.fullPath}`,
    )
  }
  return {
    installRoot,
    installRootLength: installRoot.length,
    limit: maxPathLength,
    maxPathLength: longest.fullPath.length,
    longestPath: longest.path,
    paths: checked.length,
  }
}

function normalizedWindowsRelativePath(value) {
  const path = String(value).replaceAll('/', '\\')
  const components = path.split('\\')
  if (
    !path
    || path.startsWith('\\')
    || /^[A-Za-z]:\\/u.test(path)
    || components.some(component => !component || component === '.' || component === '..')
  ) {
    throw new Error(`invalid Windows installer relative path: ${String(value)}`)
  }
  return path
}
