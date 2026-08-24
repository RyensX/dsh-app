export function parseArgs(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token?.startsWith('--')) throw new Error(`unexpected argument: ${String(token)}`)
    const key = token.slice(2)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for --${key}`)
    values.set(key, value)
    index += 1
  }
  return values
}

export function requiredArg(values, key) {
  const value = values.get(key)
  if (!value) throw new Error(`missing required --${key}`)
  return value
}
