import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-cmdline'
import { openCommandLine } from './launcher.ts'
import {
  assertRuntimeChannel,
  readRuntimeChannel,
  writeRuntimeChannel,
  type RuntimeChannel,
} from './runtime-channel.ts'

const RESTART_ACK_DELAY_MS = 250

type OperationState = {
  state: 'idle' | 'building' | 'ready' | 'failed'
  action?: 'update' | 'restore'
  stage?: OperationStage
  detail?: string
  tag?: string
  commit?: string
}

type OperationStage =
  | 'preparingUpdate'
  | 'preparingRestore'
  | 'syncingSource'
  | 'installingDependencies'
  | 'preparingToolchain'
  | 'compiling'
  | 'assembling'
  | 'validating'
  | 'updateReady'
  | 'restoreReady'

type RuntimeInfo = {
  edition: 'bundled' | 'lite'
  origin: 'bundled' | 'managed'
  repository: string
  tag: string | null
  commit: string
  commitTime: string | null
  channel: RuntimeChannel
  canRestoreBaseline: boolean
  operation: OperationState
}

/** dsh Host 中的受限控制面；浏览器不能传入 URL、路径或命令。 */
class RuntimeGateway extends TypertRemoteService {
  private operation: OperationState = pendingOperation()

  constructor(private readonly ctx: Context) {
    super(ctx, 'dshAppRuntime')
  }

  @Remote('info')
  async info(): Promise<RuntimeInfo> {
    return {
      edition: requiredEdition(),
      origin: requiredEnvironment('DSH_APP_RUNTIME_ORIGIN') as RuntimeInfo['origin'],
      repository: requiredEnvironment('DSH_APP_DSH_REPOSITORY'),
      tag: optionalEnvironment('DSH_APP_DSH_TAG'),
      commit: requiredEnvironment('DSH_APP_DSH_COMMIT'),
      commitTime: optionalEnvironment('DSH_APP_DSH_COMMIT_TIME'),
      channel: readRuntimeChannel(configPath()),
      canRestoreBaseline: canRestoreBaseline(),
      operation: this.operation,
    }
  }

  @Remote('checkUpdate')
  async checkUpdate(): Promise<{
    channel: RuntimeChannel
    currentCommit: string
    currentTag: string | null
    latestTag: string | null
    latestBranch: string | null
    latestCommit: string
    latestCommitTime: string
    updateAvailable: boolean
    upToDate: boolean
  }> {
    const args = [
      'check-update',
      '--current-commit', requiredEnvironment('DSH_APP_DSH_COMMIT'),
      '--channel', readRuntimeChannel(configPath()),
    ]
    const currentTag = optionalEnvironment('DSH_APP_DSH_TAG')
    if (currentTag !== null) args.push('--current-tag', currentTag)
    return await runManagerForResult(args)
  }

  @Remote('setChannel')
  async setChannel(channel: string): Promise<RuntimeChannel> {
    assertRuntimeChannel(channel)
    writeRuntimeChannel(configPath(), channel)
    return channel
  }

  @Remote('update')
  async update(
    channel: string,
    tag: string | null,
    branch: string | null,
    commit: string,
  ): Promise<OperationState> {
    if (this.operation.state === 'building') return this.operation
    assertRuntimeChannel(channel)
    if (channel === 'stable' && (tag === null || !/^dsh-v[0-9A-Za-z.+-]+$/u.test(tag))) {
      throw new Error('DSH_APP_INVALID_TAG')
    }
    if (channel === 'latest' && tag !== null) throw new Error('DSH_APP_INVALID_TAG')
    if (channel === 'stable' && branch !== null) throw new Error('DSH_APP_INVALID_BRANCH')
    if (channel === 'latest' && (branch === null || !isValidBranch(branch))) {
      throw new Error('DSH_APP_INVALID_BRANCH')
    }
    if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error('DSH_APP_INVALID_COMMIT')
    return this.installRuntime({
      action: 'update',
      tag,
      branch,
      commit,
      activation: 'pending',
      initialStage: 'preparingUpdate',
      readyStage: 'updateReady',
    })
  }

  @Remote('openCommandLine')
  async openCommandLine(): Promise<void> {
    await openCommandLine()
  }

  @Remote('operation')
  async getOperation(): Promise<OperationState> {
    if (this.operation.state === 'idle') this.operation = pendingOperation()
    else if (this.operation.state === 'ready' && !existsSync(pendingActionPath())) {
      // 新运行时达到 readiness 后，Rust 会消费待生效文件；不要再次提示重启。
      this.operation = { state: 'idle' }
    }
    return this.operation
  }

  @Remote('prepareRestore')
  async prepareRestore(): Promise<OperationState> {
    if (this.operation.state === 'building') return this.operation
    if (!canRestoreBaseline()) {
      throw new Error('DSH_APP_NO_BASELINE')
    }
    if (requiredEdition() === 'bundled') {
      atomicJson(pendingActionPath(), { schemaVersion: 1, action: 'restoreBundled' })
      this.operation = {
        state: 'ready',
        action: 'restore',
        stage: 'restoreReady',
      }
      return this.operation
    }
    return this.installRuntime({
      action: 'restore',
      tag: optionalEnvironment('DSH_APP_BASELINE_TAG'),
      commit: requiredEnvironment('DSH_APP_BASELINE_COMMIT'),
      activation: 'restore',
      initialStage: 'preparingRestore',
      readyStage: 'restoreReady',
    })
  }

  @Remote('restart')
  async restart(): Promise<void> {
    if (this.operation.state !== 'ready' && pendingOperation().state !== 'ready') {
      throw new Error('DSH_APP_NO_PENDING')
    }
    atomicJson(requiredEnvironment('DSH_APP_CONTROL_REQUEST'), {
      schemaVersion: 1,
      action: 'restart',
      notBeforeMs: Date.now() + RESTART_ACK_DELAY_MS,
    })
  }

  private installRuntime(request: {
    action: 'update' | 'restore'
    tag: string | null
    branch?: string | null
    commit: string
    activation: 'pending' | 'restore'
    initialStage: 'preparingUpdate' | 'preparingRestore'
    readyStage: 'updateReady' | 'restoreReady'
  }): OperationState {
    if (this.operation.state === 'building') return this.operation
    this.operation = {
      state: 'building',
      action: request.action,
      stage: request.initialStage,
      commit: request.commit,
      ...(request.tag === null ? {} : { tag: request.tag }),
    }
    const child = spawnManager([
      'install',
      ...(request.tag === null ? [] : ['--tag', request.tag]),
      ...(request.branch === null || request.branch === undefined ? [] : ['--branch', request.branch]),
      '--commit', request.commit,
      '--activation', request.activation,
    ])
    createInterface({ input: child.stdout }).on('line', line => {
      const event = parseManagerEvent(line)
      if (event?.type === 'progress') {
        const stage = operationStage(event.stage)
        if (stage !== null) this.operation = { ...this.operation, stage }
      }
      if (event?.type === 'result') {
        this.operation = {
          state: 'ready',
          action: request.action,
          stage: request.readyStage,
          ...(typeof event.tag === 'string' ? { tag: event.tag } : {}),
          commit: typeof event.commit === 'string' ? event.commit : request.commit,
        }
      }
    })
    let stderr = ''
    child.stderr.on('data', chunk => {
      stderr = `${stderr}${String(chunk)}`.slice(-4000)
    })
    child.once('error', error => {
      this.operation = {
        state: 'failed',
        action: request.action,
        detail: error.message,
        ...(request.tag === null ? {} : { tag: request.tag }),
      }
    })
    child.once('exit', code => {
      if (code !== 0 && this.operation.state === 'building') {
        this.operation = {
          state: 'failed',
          action: request.action,
          detail: safeFailure(stderr || `runtime manager exited with ${String(code)}`),
          ...(request.tag === null ? {} : { tag: request.tag }),
        }
      }
    })
    return this.operation
  }
}

export function apply(ctx: Context): void {
  new RuntimeGateway(ctx)
}

function managerBaseArgs(): string[] {
  return [
    '--bootstrap', requiredEnvironment('DSH_APP_BOOTSTRAP_MANIFEST'),
    '--user-runtime', requiredEnvironment('DSH_APP_USER_RUNTIME'),
    '--plugin-payload', requiredEnvironment('DSH_APP_PLUGIN_PAYLOAD'),
    '--corepack', requiredEnvironment('DSH_APP_COREPACK'),
  ]
}

function spawnManager(args: string[]) {
  return spawn(
    requiredEnvironment('DSH_APP_NODE'),
    [requiredEnvironment('DSH_APP_RUNTIME_MANAGER'), args[0], ...managerBaseArgs(), ...args.slice(1)],
    {
      env: cleanEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )
}

async function runManagerForResult<T>(args: string[]): Promise<T> {
  const child = spawnManager(args)
  let result: T | undefined
  let stderr = ''
  createInterface({ input: child.stdout }).on('line', line => {
    const event = parseManagerEvent(line)
    if (event?.type === 'result') result = event as T
  })
  child.stderr.on('data', chunk => { stderr = `${stderr}${String(chunk)}`.slice(-4000) })
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  if (code !== 0 || result === undefined) {
    throw new Error(safeFailure(stderr || `runtime manager exited with ${String(code)}`))
  }
  return result
}

function pendingOperation(): OperationState {
  try {
    const value = JSON.parse(readFileSync(pendingActionPath(), 'utf8')) as {
      action?: string
      tag?: string
      commit?: string
    }
    const restoring = value.action === 'restoreBundled' || value.action === 'restoreManaged'
    return {
      state: 'ready',
      action: restoring ? 'restore' : 'update',
      stage: restoring ? 'restoreReady' : 'updateReady',
      ...(value.tag === undefined ? {} : { tag: value.tag }),
      ...(value.commit === undefined ? {} : { commit: value.commit }),
    }
  } catch {
    return { state: 'idle' }
  }
}

function pendingActionPath(): string {
  return join(requiredEnvironment('DSH_APP_USER_RUNTIME'), 'pending-action.json')
}

function configPath(): string {
  return requiredEnvironment('DSH_APP_CONFIG')
}

function isValidBranch(branch: string): boolean {
  return /^[A-Za-z0-9._/-]+$/u.test(branch)
    && !branch.startsWith('-')
    && !branch.startsWith('/')
    && !branch.endsWith('/')
    && !branch.endsWith('.')
    && !branch.endsWith('.lock')
    && !branch.includes('..')
    && !branch.includes('//')
}

function canRestoreBaseline(): boolean {
  const edition = requiredEdition()
  const hasFallback = edition === 'lite' || process.env.DSH_APP_HAS_BUILTIN === '1'
  return hasFallback
    && requiredEnvironment('DSH_APP_DSH_COMMIT') !== requiredEnvironment('DSH_APP_BASELINE_COMMIT')
}

function requiredEdition(): 'bundled' | 'lite' {
  const value = requiredEnvironment('DSH_APP_EDITION')
  if (value !== 'bundled' && value !== 'lite') throw new Error(`DSH_APP_UNKNOWN_EDITION\n${value}`)
  return value
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`DSH_APP_MISSING_ENVIRONMENT\n${name}`)
  return value
}

function optionalEnvironment(name: string): string | null {
  const value = process.env[name]
  return value === undefined || value === '' ? null : value
}

function cleanEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env }
  delete environment.NODE_OPTIONS
  delete environment.NODE_PATH
  return environment
}

function parseManagerEvent(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line) as unknown
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${process.pid}`
  const backup = `${path}.previous-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  let movedPrevious = false
  try {
    try {
      renameSync(path, backup)
      movedPrevious = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    renameSync(temporary, path)
    rmSync(backup, { force: true })
  } catch (error) {
    rmSync(temporary, { force: true })
    if (movedPrevious) {
      try { renameSync(backup, path) } catch {}
    }
    throw error
  }
}

function safeFailure(value: string): string {
  return value
    .split(/\r?\n/u)
    .map(line => /API_KEY|PASSWORD|SECRET|ACCESS_TOKEN|AUTHORIZATION/iu.test(line)
      ? '[redacted sensitive output]'
      : line)
    .join('\n')
    .slice(-4000)
}

function operationStage(value: unknown): OperationStage | null {
  switch (value) {
    case 'preparingUpdate':
    case 'preparingRestore':
    case 'syncingSource':
    case 'installingDependencies':
    case 'preparingToolchain':
    case 'compiling':
    case 'assembling':
    case 'validating':
    case 'updateReady':
    case 'restoreReady':
      return value
    default:
      return null
  }
}
