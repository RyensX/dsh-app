import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs, requiredArg } from './lib/args.mjs'

const args = parseArgs(process.argv.slice(2))
const assetsDirectory = resolve(requiredArg(args, 'assets'))
const expectedAssetCount = Number(requiredArg(args, 'expected-count'))

function requiredEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`missing required environment variable: ${name}`)
  return value
}

if (!Number.isSafeInteger(expectedAssetCount) || expectedAssetCount <= 0) {
  throw new Error(`invalid --expected-count: ${String(expectedAssetCount)}`)
}

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
if (!token) throw new Error('missing GH_TOKEN or GITHUB_TOKEN')

const repository = requiredEnv('GITHUB_REPOSITORY')
const commitSha = requiredEnv('GITHUB_SHA')
const runId = requiredEnv('GITHUB_RUN_ID')
const runNumber = requiredEnv('GITHUB_RUN_NUMBER')
const runAttempt = requiredEnv('GITHUB_RUN_ATTEMPT')
const defaultBranch = requiredEnv('DEFAULT_BRANCH')
const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com'
const apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com'
const releaseTag = process.env.RELEASE_TAG || 'latest-commit-pre-release'
const transactionPrefix = '<!-- dsh-app-pre-release-transaction:'
const transactionMarker = `${transactionPrefix}${runId}:${runAttempt}:${commitSha} -->`

const apiHeaders = {
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'User-Agent': 'dsh-app-pre-release-publisher',
  'X-GitHub-Api-Version': '2022-11-28',
}

class GitHubApiError extends Error {
  constructor(method, url, response, message) {
    const requestId = response.headers.get('x-github-request-id')
    super(
      `${method} ${url.pathname} failed with HTTP ${response.status}`
      + `${requestId ? ` (request ${requestId})` : ''}: ${message}`,
    )
    this.name = 'GitHubApiError'
    this.status = response.status
  }
}

function apiEndpoint(path) {
  return new URL(path.replace(/^\//, ''), `${apiUrl.replace(/\/$/, '')}/`)
}

async function requestJson(pathOrUrl, options = {}) {
  const method = options.method || 'GET'
  const url = pathOrUrl instanceof URL
    ? pathOrUrl
    : String(pathOrUrl).startsWith('https://')
      ? new URL(pathOrUrl)
      : apiEndpoint(pathOrUrl)
  const headers = { ...apiHeaders, ...options.headers }
  if (options.body !== undefined && headers['Content-Type'] === undefined) {
    headers['Content-Type'] = 'application/json; charset=utf-8'
  }
  const response = await fetch(url, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const text = await response.text()

  if (options.allowNotFound && response.status === 404) return null
  const expectedStatuses = options.expectedStatuses || [200]
  if (!expectedStatuses.includes(response.status)) {
    let message = text.trim() || response.statusText
    try {
      message = JSON.parse(text).message || message
    } catch {
      // 非 JSON 错误正文保留原始文本。
    }
    throw new GitHubApiError(method, url, response, message)
  }
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${method} ${url.pathname} returned invalid JSON`)
  }
}

function assertRelease(value, context) {
  if (!value || typeof value !== 'object') throw new Error(`${context} is not an object`)
  if (!Number.isSafeInteger(value.id) || value.id <= 0) throw new Error(`${context} has an invalid id`)
  if (typeof value.tag_name !== 'string') throw new Error(`${context} has an invalid tag_name`)
  if (typeof value.draft !== 'boolean') throw new Error(`${context} has an invalid draft flag`)
  if (typeof value.prerelease !== 'boolean') throw new Error(`${context} has an invalid prerelease flag`)
  return value
}

function assertReleaseId(value, context) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${context} has an invalid release id`)
  return value
}

function assertTag(value, context) {
  if (!value || value.ref !== `refs/tags/${releaseTag}` || typeof value.object?.sha !== 'string') {
    throw new Error(`${context} is not a valid ${releaseTag} tag reference`)
  }
  return value
}

async function getReleaseByTag() {
  const value = await requestJson(
    `/repos/${repository}/releases/tags/${encodeURIComponent(releaseTag)}`,
    { allowNotFound: true },
  )
  return value === null ? null : assertRelease(value, `release ${releaseTag}`)
}

async function listReleases() {
  const releases = []
  for (let page = 1; page <= 10; page += 1) {
    const values = await requestJson(`/repos/${repository}/releases?per_page=100&page=${page}`)
    if (!Array.isArray(values)) throw new Error('release list response is not an array')
    for (const value of values) releases.push(assertRelease(value, 'release list entry'))
    if (values.length < 100) return releases
  }
  throw new Error('release list exceeded 1000 entries')
}

async function listReleaseAssets(releaseId) {
  assertReleaseId(releaseId, 'asset lookup')
  const assets = []
  for (let page = 1; page <= 10; page += 1) {
    const values = await requestJson(
      `/repos/${repository}/releases/${releaseId}/assets?per_page=100&page=${page}`,
    )
    if (!Array.isArray(values)) throw new Error(`asset list for release ${releaseId} is not an array`)
    assets.push(...values)
    if (values.length < 100) return assets
  }
  throw new Error(`asset list for release ${releaseId} exceeded 1000 entries`)
}

async function getCanonicalTag() {
  const value = await requestJson(
    `/repos/${repository}/git/ref/tags/${encodeURIComponent(releaseTag)}`,
    { allowNotFound: true },
  )
  return value === null ? null : assertTag(value, `tag ${releaseTag}`)
}

async function moveCanonicalTag(sha) {
  const current = await getCanonicalTag()
  if (!current) return false
  if (current.object.sha !== sha) {
    await requestJson(`/repos/${repository}/git/refs/tags/${encodeURIComponent(releaseTag)}`, {
      method: 'PATCH',
      body: { sha, force: true },
    })
  }
  const updated = await getCanonicalTag()
  if (!updated || updated.object.sha !== sha) {
    throw new Error(`tag ${releaseTag} did not resolve to ${sha}`)
  }
  return true
}

async function updateRelease(id, fields) {
  assertReleaseId(id, 'release update')
  const value = await requestJson(`/repos/${repository}/releases/${id}`, {
    method: 'PATCH',
    body: fields,
  })
  return assertRelease(value, `updated release ${id}`)
}

async function deleteRelease(id) {
  assertReleaseId(id, 'release deletion')
  await requestJson(`/repos/${repository}/releases/${id}`, {
    method: 'DELETE',
    expectedStatuses: [204],
    allowNotFound: true,
  })
}

async function retry(label, operation, attempts = 3) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (attempt < attempts) {
        console.warn(`${label} failed on attempt ${attempt}; retrying.`)
        await new Promise((resolvePromise) => setTimeout(resolvePromise, attempt * 1000))
      }
    }
  }
  throw lastError
}

async function loadLocalAssets() {
  const entries = await readdir(assetsDirectory, { withFileTypes: true })
  const assets = []
  const names = new Set()
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (names.has(entry.name)) throw new Error(`duplicate local asset name: ${entry.name}`)
    const path = resolve(assetsDirectory, entry.name)
    const metadata = await stat(path)
    if (metadata.size <= 0) throw new Error(`installer asset is empty: ${entry.name}`)
    names.add(entry.name)
    assets.push({ name: entry.name, path, size: metadata.size })
  }
  assets.sort((left, right) => left.name.localeCompare(right.name))
  if (assets.length !== expectedAssetCount) {
    throw new Error(`expected ${expectedAssetCount} installer assets, found ${assets.length}`)
  }
  return assets
}

async function verifyReleaseAssets(releaseId, localAssets) {
  const remoteAssets = await listReleaseAssets(releaseId)
  if (remoteAssets.length !== localAssets.length) {
    throw new Error(
      `release ${releaseId} contains ${remoteAssets.length} assets; expected ${localAssets.length}`,
    )
  }
  const remoteByName = new Map()
  for (const asset of remoteAssets) {
    if (remoteByName.has(asset.name)) throw new Error(`release ${releaseId} has duplicate asset ${asset.name}`)
    remoteByName.set(asset.name, asset)
  }
  for (const localAsset of localAssets) {
    const remoteAsset = remoteByName.get(localAsset.name)
    if (!remoteAsset) throw new Error(`release ${releaseId} is missing ${localAsset.name}`)
    if (remoteAsset.state !== 'uploaded' || remoteAsset.size !== localAsset.size) {
      throw new Error(
        `release ${releaseId} asset ${localAsset.name} is incomplete `
        + `(${String(remoteAsset.state)}, ${String(remoteAsset.size)}/${localAsset.size})`,
      )
    }
  }
}

async function uploadAsset(uploadTemplate, releaseId, asset) {
  if (typeof uploadTemplate !== 'string') throw new Error(`release ${releaseId} has no upload URL`)
  const uploadUrl = new URL(uploadTemplate.replace(/\{.*$/, ''))
  const expectedPath = `/repos/${repository}/releases/${releaseId}/assets`
  if (uploadUrl.protocol !== 'https:' || uploadUrl.hostname !== 'uploads.github.com' || uploadUrl.pathname !== expectedPath) {
    throw new Error(`release ${releaseId} returned an unexpected upload URL`)
  }
  uploadUrl.searchParams.set('name', asset.name)
  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      ...apiHeaders,
      'Content-Length': String(asset.size),
      'Content-Type': 'application/octet-stream',
    },
    body: createReadStream(asset.path),
    duplex: 'half',
  })
  const text = await response.text()
  if (response.status !== 201) {
    let message = text.trim() || response.statusText
    try {
      message = JSON.parse(text).message || message
    } catch {
      // 非 JSON 错误正文保留原始文本。
    }
    throw new GitHubApiError('POST', uploadUrl, response, message)
  }
}

async function uploadAssets(uploadUrl, releaseId, assets) {
  const queue = [...assets]
  const worker = async () => {
    while (queue.length > 0) {
      const asset = queue.shift()
      if (asset) await uploadAsset(uploadUrl, releaseId, asset)
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, assets.length) }, () => worker()))
}

async function buildReleaseNotes(assetCount) {
  const commit = await requestJson(`/repos/${repository}/commits/${commitSha}`)
  const commitMessage = commit?.commit?.message
  if (typeof commitMessage !== 'string') throw new Error(`commit ${commitSha} has no message`)
  const shortSha = commitSha.slice(0, 7)
  const quote = commitMessage.split('\n').map((line) => `> ${line}`).join('\n')
  return `## 最新提交构建

| 构建信息 | 详情 |
| --- | --- |
| 提交 | [\`${shortSha}\`](${serverUrl}/${repository}/commit/${commitSha}) |
| 工作流 | [运行 #${runNumber} · 尝试 ${runAttempt}](${serverUrl}/${repository}/actions/runs/${runId}) |
| 安装包 | 成功生成 ${assetCount} 个 |

### 提交说明

${quote}

### 构建产物

> [!WARNING]
> 这是根据最新提交自动生成的构建版本，可能不稳定、功能不完整，或包含已知及未知问题。请谨慎使用，不要将其用于生产环境或其他关键工作。

macOS 用户首次启动前请阅读 [macOS 首次启动授权指南](${serverUrl}/${repository}/blob/${commitSha}/docs/macos-installation.zh.md)。

---

## Latest commit build

| Build | Details |
| --- | --- |
| Commit | [\`${shortSha}\`](${serverUrl}/${repository}/commit/${commitSha}) |
| Workflow | [Run #${runNumber} · attempt ${runAttempt}](${serverUrl}/${repository}/actions/runs/${runId}) |
| Installers | ${assetCount} successfully produced |

### Commit message

${quote}

### Artifacts

> [!WARNING]
> This is an automatically generated build from the latest commit. It may be unstable, incomplete, or contain known or unknown issues. Use it with caution, and do not rely on it for production or other critical work.

Before opening the app for the first time on macOS, read the [macOS first-launch authorization guide](${serverUrl}/${repository}/blob/${commitSha}/docs/macos-installation.md).
`
}

async function defaultBranchHead() {
  const commit = await requestJson(`/repos/${repository}/commits/${encodeURIComponent(defaultBranch)}`)
  if (typeof commit?.sha !== 'string') throw new Error(`default branch ${defaultBranch} has no commit SHA`)
  return commit.sha
}

function isOwnedDraft(release) {
  return release.draft === true
    && typeof release.body === 'string'
    && release.body.includes(transactionPrefix)
}

async function cleanupInterruptedDrafts() {
  const releases = await listReleases()
  for (const release of releases.filter(isOwnedDraft)) {
    console.log(`Cleaning interrupted draft release ${release.id}.`)
    await retry(`delete interrupted draft ${release.id}`, () => deleteRelease(release.id))
  }
}

async function verifyPublishedRelease(release, localAssets) {
  if (release.tag_name !== releaseTag || release.draft || !release.prerelease) {
    throw new Error(`release ${release.id} is not the canonical pre-release`)
  }
  if (!release.published_at) throw new Error(`release ${release.id} has no published_at`)
  await retry(`wait for canonical release ${release.id}`, async () => {
    const canonical = await getReleaseByTag()
    if (!canonical || canonical.id !== release.id) {
      throw new Error(`release ${release.id} is not addressable through ${releaseTag}`)
    }
    const tag = await getCanonicalTag()
    if (!tag || tag.object.sha !== commitSha) {
      throw new Error(`tag ${releaseTag} does not point to ${commitSha}`)
    }
  }, 5)
  await verifyReleaseAssets(release.id, localAssets)
}

async function main() {
  const localAssets = await loadLocalAssets()
  const notes = await buildReleaseNotes(localAssets.length)

  const initialHead = await defaultBranchHead()
  if (initialHead !== commitSha) {
    console.log(`Skipping stale build ${commitSha}; ${defaultBranch} is now at ${initialHead}.`)
    return
  }

  await cleanupInterruptedDrafts()
  let oldRelease = await getReleaseByTag()
  if (oldRelease?.draft) {
    if (!isOwnedDraft(oldRelease)) {
      throw new Error(`unrecognized draft is using ${releaseTag}: release ${oldRelease.id}`)
    }
    await retry(`delete interrupted canonical draft ${oldRelease.id}`, () => deleteRelease(oldRelease.id))
    oldRelease = null
  }
  if (oldRelease && !oldRelease.prerelease) {
    throw new Error(`existing release ${oldRelease.id} is not a pre-release`)
  }

  const oldTag = await getCanonicalTag()
  if (oldRelease && !oldTag) {
    throw new Error(`existing release ${oldRelease.id} has no ${releaseTag} tag`)
  }

  const deleteHead = await defaultBranchHead()
  if (deleteHead !== commitSha) {
    console.log(`Skipping stale build ${commitSha}; ${defaultBranch} is now at ${deleteHead}.`)
    return
  }

  if (oldRelease) {
    console.log(`All local checks passed; deleting old release ${oldRelease.id}.`)
    await retry(`delete old release ${oldRelease.id}`, () => deleteRelease(oldRelease.id))
  }

  const movedExistingTag = await moveCanonicalTag(commitSha)
  if (oldRelease && !movedExistingTag) {
    throw new Error(`existing ${releaseTag} tag disappeared after deleting release ${oldRelease.id}`)
  }

  let newReleaseId = null
  let newReleaseReady = false
  try {
    console.log(`Creating a new draft release for ${commitSha}.`)
    const draft = assertRelease(await requestJson(`/repos/${repository}/releases`, {
      method: 'POST',
      expectedStatuses: [201],
      body: {
        tag_name: releaseTag,
        target_commitish: commitSha,
        name: `${releaseTag} transaction ${runId}.${runAttempt}`,
        body: `${notes}\n\n${transactionMarker}`,
        draft: true,
        prerelease: true,
        make_latest: 'false',
      },
    }), 'new draft release')
    newReleaseId = draft.id

    console.log(`Uploading ${localAssets.length} assets to draft release ${draft.id}.`)
    await uploadAssets(draft.upload_url, draft.id, localAssets)
    await verifyReleaseAssets(draft.id, localAssets)

    const publishHead = await defaultBranchHead()
    if (publishHead !== commitSha) {
      throw new Error(
        `build ${commitSha} became stale before publication; ${defaultBranch} is at ${publishHead}`,
      )
    }

    console.log(`Publishing release ${draft.id}.`)
    const published = await updateRelease(draft.id, {
      tag_name: releaseTag,
      target_commitish: commitSha,
      name: releaseTag,
      body: notes,
      draft: false,
      prerelease: true,
      make_latest: 'false',
    })
    await verifyPublishedRelease(published, localAssets)
    newReleaseReady = true
    console.log(`Pre-release ${published.id} published safely at ${published.published_at}.`)
  } catch (error) {
    if (!newReleaseReady && newReleaseId) {
      try {
        await retry(`delete incomplete release ${newReleaseId}`, () => deleteRelease(newReleaseId))
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'new pre-release failed and its draft cleanup was incomplete')
      }
    }
    throw error
  }
}

main().catch((error) => {
  if (error instanceof AggregateError) {
    console.error(`::error::${error.message}`)
    for (const nested of error.errors) console.error(nested)
  } else {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`)
  }
  process.exitCode = 1
})
