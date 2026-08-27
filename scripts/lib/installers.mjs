const EDITIONS = new Set(['bundled', 'lite'])
const PLATFORMS = new Set(['macos', 'windows'])
const ARCHITECTURES = new Set(['arm64', 'x64'])
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/u
const SUFFIX_PATTERN = /^[0-9A-Za-z][0-9A-Za-z-]*$/u
const COMMIT_PATTERN = /^[0-9A-Fa-f]{7,40}$/u
const SHORT_COMMIT_LENGTH = 7

/**
 * @typedef {object} InstallerFilenameOptions
 * @property {string} edition
 * @property {string} version
 * @property {string} platform
 * @property {string} arch
 * @property {string} [suffix]
 * @property {string} [commit]
 */

/**
 * 统一所有本地与 CI 安装器的最终文件名。
 * @param {InstallerFilenameOptions} options
 */
export function installerFilename({ edition, version, platform, arch, suffix, commit }) {
  if (!EDITIONS.has(edition)) throw new Error(`invalid installer edition: ${edition}`)
  if (!VERSION_PATTERN.test(version)) throw new Error(`invalid installer version: ${version}`)
  if (!PLATFORMS.has(platform)) throw new Error(`invalid installer platform: ${platform}`)
  if (!ARCHITECTURES.has(arch)) throw new Error(`invalid installer architecture: ${arch}`)
  if ((suffix === undefined) !== (commit === undefined)) {
    throw new Error('installer suffix and commit must be provided together')
  }

  let qualifier = ''
  if (suffix !== undefined && commit !== undefined) {
    if (!SUFFIX_PATTERN.test(suffix)) throw new Error(`invalid installer suffix: ${suffix}`)
    if (!COMMIT_PATTERN.test(commit)) throw new Error(`invalid installer commit: ${commit}`)
    qualifier = `_${suffix}_${commit.slice(0, SHORT_COMMIT_LENGTH).toLowerCase()}`
  }

  const extension = platform === 'macos' ? '.dmg' : '.exe'
  return `dsh-app-${edition}-${version}-${platform}-${arch}${qualifier}${extension}`
}
