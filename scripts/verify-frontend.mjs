import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { parseArgs, requiredArg } from './lib/args.mjs'

const args = parseArgs(process.argv.slice(2))
const edition = requiredArg(args, 'edition')
const root = resolve(requiredArg(args, 'path'))
if (!existsSync(root)) throw new Error(`frontend path does not exist: ${root}`)

const files = []
function walk(path) {
  const stat = lstatSync(path)
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) walk(resolve(path, entry))
  } else if (stat.isFile()) {
    files.push(path)
  }
}
walk(root)

const contains = marker => files.some(file => readFileSync(file).includes(Buffer.from(marker)))
const names = new Set(files.map(file => basename(file)))
const liteMarkers = ['Choose Node', 'Use Bundled']
if (!contains('Open data directory')) throw new Error(`${edition} frontend is missing the data-directory action`)

if (edition === 'bundled') {
  if (!names.has('index.html')) throw new Error('Bundled frontend has no index.html')
  if (names.has('lite.html')) throw new Error('Bundled frontend contains lite.html')
  for (const marker of liteMarkers) {
    if (contains(marker)) throw new Error(`Bundled frontend contains Lite-only marker: ${marker}`)
  }
} else if (edition === 'lite') {
  if (!names.has('lite.html')) throw new Error('Lite frontend has no lite.html')
  if (names.has('index.html')) throw new Error('Lite frontend contains Bundled index.html')
  for (const marker of liteMarkers) {
    if (!contains(marker)) throw new Error(`Lite frontend is missing control: ${marker}`)
  }
} else {
  throw new Error(`invalid edition: ${edition}`)
}

console.log(`Frontend verified: ${edition}, ${files.length} files`)
