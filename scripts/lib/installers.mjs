const EDITIONS = new Set(['bundled', 'lite'])
const PLATFORMS = new Set(['macos', 'windows'])
const ARCHITECTURES = new Set(['arm64', 'x64'])
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/u

/** 统一所有本地与 CI 安装器的最终文件名。 */
export function installerFilename({ edition, version, platform, arch }) {
  if (!EDITIONS.has(edition)) throw new Error(`invalid installer edition: ${edition}`)
  if (!VERSION_PATTERN.test(version)) throw new Error(`invalid installer version: ${version}`)
  if (!PLATFORMS.has(platform)) throw new Error(`invalid installer platform: ${platform}`)
  if (!ARCHITECTURES.has(arch)) throw new Error(`invalid installer architecture: ${arch}`)
  const extension = platform === 'macos' ? '.dmg' : '.exe'
  return `dsh-app-${edition}-${version}-${platform}-${arch}${extension}`
}
