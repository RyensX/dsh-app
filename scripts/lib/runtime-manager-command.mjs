/**
 * 生成托管运行时安装命令参数。浅克隆可能没有 tag 信息，此时只按精确 commit 安装。
 * @param {{
 *   runtimeManager: string
 *   bootstrapPath: string
 *   userRuntime: string
 *   pluginPayload: string
 *   corepack: string
 *   commit: string
 *   tag: string | null
 *   activation?: 'current' | 'pending' | 'restore'
 * }} options
 */
export function managedRuntimeInstallArgs({
  runtimeManager,
  bootstrapPath,
  userRuntime,
  pluginPayload,
  corepack,
  commit,
  tag,
  activation = 'current',
}) {
  const args = [
    runtimeManager,
    'install',
    '--bootstrap', bootstrapPath,
    '--user-runtime', userRuntime,
    '--plugin-payload', pluginPayload,
    '--corepack', corepack,
    '--commit', commit,
  ]
  if (tag !== null) args.push('--tag', tag)
  args.push('--activation', activation)
  return args
}
