import { spawnSync } from 'node:child_process'

export function run(command, args, options = {}) {
  const printable = [command, ...args].join(' ')
  console.log(`> ${printable}`)
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const output = options.capture ? `\n${result.stdout ?? ''}${result.stderr ?? ''}` : ''
    throw new Error(`${printable} exited with ${String(result.status)}${output}`)
  }
  return options.capture ? String(result.stdout ?? '').trim() : ''
}
