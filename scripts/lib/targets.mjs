const TARGETS = {
  'aarch64-apple-darwin': {
    appTarget: 'macos',
    nodePlatform: 'darwin',
    nodeArch: 'arm64',
    nodeArchive: version => `node-v${version}-darwin-arm64.tar.gz`,
  },
  'x86_64-apple-darwin': {
    appTarget: 'macos',
    nodePlatform: 'darwin',
    nodeArch: 'x64',
    nodeArchive: version => `node-v${version}-darwin-x64.tar.gz`,
  },
  'x86_64-pc-windows-msvc': {
    appTarget: 'windows',
    nodePlatform: 'win32',
    nodeArch: 'x64',
    nodeArchive: version => `node-v${version}-win-x64.zip`,
  },
}

export function targetInfo(triple) {
  const info = TARGETS[triple]
  if (!info) throw new Error(`unsupported target triple: ${triple}`)
  return { triple, ...info }
}

export function hostTarget() {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'aarch64-apple-darwin'
  if (process.platform === 'darwin' && process.arch === 'x64') return 'x86_64-apple-darwin'
  if (process.platform === 'win32' && process.arch === 'x64') return 'x86_64-pc-windows-msvc'
  throw new Error(`unsupported build host: ${process.platform}/${process.arch}`)
}

export function assertNativeTarget(info) {
  if (process.platform !== info.nodePlatform || process.arch !== info.nodeArch) {
    throw new Error(
      `dsh production dependencies must be built on the native target: requested ${info.nodePlatform}/${info.nodeArch}, host is ${process.platform}/${process.arch}`,
    )
  }
}
