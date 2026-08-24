import * as React from 'react'
import type { CSSProperties } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button, IconChevronDownOutline14, IconLoadingOutline16, Menu, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { en, zh, type RuntimeKey } from './locales.ts'

const NS = 'settings.dshAppRuntime'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.dshAppRuntime': RuntimeKey
  }
}

type Translate = (key: RuntimeKey) => string
type LocaleId = 'zh' | 'en'
type RuntimeChannel = 'stable' | 'latest'
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

type OperationState = {
  state: 'idle' | 'building' | 'ready' | 'failed'
  action?: 'update' | 'restore'
  stage?: OperationStage
  detail?: string
  tag?: string
  commit?: string
}

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

type UpdateInfo = {
  channel: RuntimeChannel
  currentCommit: string
  currentTag: string | null
  latestTag: string | null
  latestBranch: string | null
  latestCommit: string
  latestCommitTime: string
  updateAvailable: boolean
  upToDate: boolean
}

class RuntimeStore {
  private snapshot: {
    info: RuntimeInfo | null
    update: UpdateInfo | null
    checking: boolean
    channelSaving: boolean
    openingCommandLine: boolean
    restarting: boolean
    error: string | null
    checkError: string | null
  } = {
    info: null,
    update: null,
    checking: false,
    channelSaving: false,
    openingCommandLine: false,
    restarting: false,
    error: null,
    checkError: null,
  }
  private readonly listeners = new Set<() => void>()
  private checkRequest = 0

  constructor(
    private readonly call: <T>(method: string, args?: unknown) => Promise<T>,
    private readonly t: Translate,
    private readonly writePrompt: (prompt: string) => boolean,
  ) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  readonly getSnapshot = () => this.snapshot

  resetCheck(): void {
    this.checkRequest += 1
    this.snapshot = { ...this.snapshot, update: null, checking: false, checkError: null }
    this.emit()
  }

  async refresh(): Promise<void> {
    if (this.snapshot.restarting) return
    try {
      const info = await this.call<RuntimeInfo>('info')
      if (this.snapshot.restarting) return
      const operation = await this.call<OperationState>('operation')
      if (this.snapshot.restarting) return
      this.snapshot = { ...this.snapshot, info: { ...info, operation }, error: null }
      this.emit()
    } catch (error) {
      if (this.snapshot.restarting) return
      this.fail(error, 'actionFailed')
    }
  }

  async checkUpdate(): Promise<void> {
    const request = ++this.checkRequest
    this.snapshot = { ...this.snapshot, update: null, checking: true, checkError: null }
    this.emit()
    try {
      const update = await this.call<UpdateInfo>('checkUpdate')
      if (request !== this.checkRequest) return
      this.snapshot = { ...this.snapshot, update, checking: false, checkError: null }
      this.emit()
    } catch (error) {
      if (request !== this.checkRequest) return
      this.snapshot = {
        ...this.snapshot,
        checking: false,
        checkError: localizedError(error, this.t, 'checkFailed'),
      }
      this.emit()
    }
  }

  async setChannel(channel: RuntimeChannel): Promise<void> {
    const info = this.snapshot.info
    if (info === null || info.channel === channel || this.snapshot.channelSaving) return
    const previous = info.channel
    this.checkRequest += 1
    this.snapshot = {
      ...this.snapshot,
      info: { ...info, channel },
      update: null,
      checking: false,
      channelSaving: true,
      checkError: null,
      error: null,
    }
    this.emit()
    try {
      const saved = await this.call<RuntimeChannel>('setChannel', { channel })
      if (saved !== channel) throw new Error('DSH_APP_INVALID_CHANNEL')
      const current = this.snapshot.info
      this.snapshot = {
        ...this.snapshot,
        info: current === null ? null : { ...current, channel: saved },
        channelSaving: false,
      }
      this.emit()
    } catch (error) {
      const current = this.snapshot.info
      this.snapshot = {
        ...this.snapshot,
        info: current === null ? null : { ...current, channel: previous },
        channelSaving: false,
        error: localizedError(error, this.t, 'channelFailed'),
      }
      this.emit()
    }
  }

  async update(): Promise<void> {
    const candidate = this.snapshot.update
    if (candidate === null || !candidate.updateAvailable) return
    this.publishOperation({
      state: 'building',
      action: 'update',
      stage: 'preparingUpdate',
      ...(candidate.latestTag === null ? {} : { tag: candidate.latestTag }),
      commit: candidate.latestCommit,
    })
    try {
      const operation = await this.call<OperationState>('update', {
        channel: candidate.channel,
        tag: candidate.latestTag,
        branch: candidate.latestBranch,
        commit: candidate.latestCommit,
      })
      this.publishOperation(operation)
      await this.refresh()
    } catch (error) {
      this.fail(error, 'actionFailed')
    }
  }

  async restore(): Promise<void> {
    const edition = this.snapshot.info?.edition
    if (edition === undefined) return
    const confirmation = edition === 'bundled'
      ? this.t('confirmRestoreBundled')
      : this.t('confirmRestoreLite')
    if (!window.confirm(confirmation)) return
    this.publishOperation({
      state: 'building',
      action: 'restore',
      stage: 'preparingRestore',
    })
    try {
      const operation = await this.call<OperationState>('prepareRestore')
      this.publishOperation(operation)
      await this.refresh()
    } catch (error) {
      this.fail(error, 'actionFailed')
    }
  }

  async restart(): Promise<void> {
    if (this.snapshot.restarting) return
    this.checkRequest += 1
    this.snapshot = {
      ...this.snapshot,
      restarting: true,
      checking: false,
      error: null,
      checkError: null,
    }
    this.emit()
    try {
      await this.call<void>('restart')
    } catch (error) {
      this.snapshot = { ...this.snapshot, restarting: false }
      this.fail(error, 'restartFailed')
    }
  }

  async openCommandLine(): Promise<void> {
    if (this.snapshot.openingCommandLine) return
    this.snapshot = { ...this.snapshot, openingCommandLine: true, error: null }
    this.emit()
    try {
      await this.call<void>('openCommandLine')
      this.snapshot = { ...this.snapshot, openingCommandLine: false }
      this.emit()
    } catch (error) {
      this.snapshot = {
        ...this.snapshot,
        openingCommandLine: false,
        error: localizedError(error, this.t, 'openCommandLineFailed'),
      }
      this.emit()
    }
  }

  prepareUpdateSummary(): boolean {
    const candidate = this.snapshot.update
    const info = this.snapshot.info
    if (candidate?.updateAvailable !== true || info === null) return false
    const repository = repositoryWebUrl(info.repository)
    const prompt = template(this.t('comparePrompt'), {
      currentCommit: candidate.currentCommit,
      latestCommit: candidate.latestCommit,
      repository,
      compareUrl: `${repository}/compare/${candidate.currentCommit}...${candidate.latestCommit}`,
    })
    if (this.writePrompt(prompt)) return true
    this.snapshot = { ...this.snapshot, error: this.t('noActiveConversation') }
    this.emit()
    return false
  }

  private fail(error: unknown, fallback: RuntimeKey): void {
    const message = localizedError(error, this.t, fallback)
    const info = this.snapshot.info
    if (info?.operation.state === 'building') {
      this.snapshot = {
        ...this.snapshot,
        info: {
          ...info,
          operation: {
            state: 'failed',
            ...(info.operation.action === undefined ? {} : { action: info.operation.action }),
            detail: message,
          },
        },
        error: null,
      }
      this.emit()
      return
    }
    this.snapshot = { ...this.snapshot, error: message }
    this.emit()
  }

  private publishOperation(operation: OperationState): void {
    const info = this.snapshot.info
    if (info === null) return
    this.snapshot = {
      ...this.snapshot,
      info: { ...info, operation },
      error: null,
    }
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

type RuntimeSectionProps = PropsRuntime<'settings.section'> & PropsLocale<typeof NS> & {
  store: RuntimeStore
}

function RuntimeSection({ store, t, close }: RuntimeSectionProps): React.ReactNode {
  const sectionRef = React.useRef<HTMLElement | null>(null)
  const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
  React.useEffect(() => {
    void store.refresh()
    // 检查结果只属于当前打开周期；进入页面不会自动发起网络请求。
    store.resetCheck()
    const timer = window.setInterval(() => { void store.refresh() }, 1000)
    return () => { window.clearInterval(timer) }
  }, [store])
  const info = state.info
  const operation = info?.operation
  const busy = operation?.state === 'building'
  const updateBuilding = busy && operation.action === 'update'
  useSettingsLock(sectionRef, busy)
  const locale = document.documentElement.lang.toLowerCase().startsWith('zh') ? 'zh' : 'en'

  return (
    <section ref={sectionRef} style={styles.section} data-dsh-app-runtime="settings">
      <style>{`@keyframes dsh-app-runtime-spin { to { transform: rotate(360deg); } }
[data-dsh-app-runtime-channel]:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover) !important; }`}</style>
      <h2 style={styles.title}>{t('title')}</h2>
      <p style={styles.intro}>{t('intro')}</p>

      <div role="note" style={styles.warningCard}>
        <p style={styles.warningText}>{t('warning')}</p>
      </div>

      {info !== null && (
        <div style={styles.channelField}>
          <span style={styles.channelLabel}>{t('channel')}</span>
          <ChannelSelector
            channel={info.channel}
            disabled={busy || state.channelSaving}
            label={t('channel')}
            stableLabel={t('channelStable')}
            latestLabel={t('channelLatest')}
            onSelect={(channel) => { void store.setChannel(channel) }}
          />
          <span style={styles.channelHint}>{t('channelHint')}</span>
        </div>
      )}

      {info === null ? (
        <StatusCard state="ongoing" title={t('loading')} />
      ) : (
        <div style={styles.runtimeCard}>
          <div style={styles.runtimeCardHeader}>
            <strong style={styles.cardTitle}>{t('currentRuntime')}</strong>
            {info.canRestoreBaseline && operation?.state !== 'ready' && (
              <Button
                variant="outline"
                size="sm"
                data-dsh-app-runtime-restore="true"
                onClick={() => { void store.restore() }}
              >
                {info.edition === 'bundled' ? t('restoreBuiltIn') : t('restoreBaseline')}
              </Button>
            )}
          </div>
          <dl style={styles.details}>
            <dt style={styles.term}>{t('source')}</dt>
            <dd style={styles.description}>
              {info.origin === 'bundled' ? t('sourceBundled') : t('sourceManaged')}
            </dd>
            <dt style={styles.term}>{t('tag')}</dt>
            <dd style={styles.description}>{info.tag ?? t('noTag')}</dd>
            <dt style={styles.term}>{t('commit')}</dt>
            <dd style={{ ...styles.description, ...styles.breakable }}>
              <CommitLink repository={info.repository} commit={info.commit} title={t('viewCommit')} />
            </dd>
            <dt style={styles.term}>{t('commitTime')}</dt>
            <dd style={styles.description}>{formatCommitTime(info.commitTime, locale, t)}</dd>
          </dl>
        </div>
      )}

      {state.update !== null && info !== null && (
        <UpdateResult
          update={state.update}
          info={info}
          t={t}
          locale={locale}
          onSummarize={() => { if (store.prepareUpdateSummary()) close() }}
        />
      )}

      {operation !== undefined && operation.state !== 'idle' && (
        <StatusCard
          state={operation.state === 'failed' ? 'error' : operation.state === 'ready' ? 'done' : 'ongoing'}
          title={operationText(operation, t)}
          detail={operation.state === 'failed' ? operation.detail : undefined}
          role={operation.state === 'failed' ? 'alert' : 'status'}
        />
      )}
      {state.error !== null && <StatusCard state="error" title={state.error} role="alert" />}
      {state.checkError !== null && <StatusCard state="error" title={state.checkError} role="alert" />}

      <div style={styles.actions}>
        <Button
          variant="outline"
          disabled={state.checking || state.channelSaving}
          onClick={() => { void store.checkUpdate() }}
        >
          {state.checking ? t('checking') : t('checkUpdate')}
        </Button>
        <Button
          variant="outline"
          disabled={state.openingCommandLine}
          onClick={() => { void store.openCommandLine() }}
        >
          {state.openingCommandLine ? t('openingCommandLine') : t('openCommandLine')}
        </Button>
        {state.update?.updateAvailable === true && operation?.state !== 'ready' && (
          <div style={styles.primaryAction}>
            <Button variant="primary" onClick={() => { void store.update() }}>
              {t('confirmUpdateAction')}
              {updateBuilding && <UpdateSpinner />}
            </Button>
          </div>
        )}
        {operation?.state === 'ready' && (
          <div style={styles.primaryAction}>
            <Button
              variant="primary"
              disabled={state.restarting}
              onClick={() => { void store.restart() }}
            >
              {t('restartNow')}
            </Button>
          </div>
        )}
      </div>
    </section>
  )
}

function ChannelSelector({ channel, disabled, label, stableLabel, latestLabel, onSelect }: {
  channel: RuntimeChannel
  disabled: boolean
  label: string
  stableLabel: string
  latestLabel: string
  onSelect: (channel: RuntimeChannel) => void
}): React.ReactNode {
  const [open, setOpen] = React.useState(false)
  React.useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])
  const selectedLabel = channel === 'stable' ? stableLabel : latestLabel

  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      items={[
        { id: 'stable', label: stableLabel },
        { id: 'latest', label: latestLabel },
      ]}
      selectedId={channel}
      onSelect={(id) => {
        setOpen(false)
        if (id !== channel) onSelect(id as RuntimeChannel)
      }}
      align="start"
      portal
      anchor={(
        <button
          type="button"
          data-dsh-app-runtime-channel="true"
          style={styles.channelSelector}
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => { setOpen(value => !value) }}
        >
          {selectedLabel}
          <IconChevronDownOutline14 style={styles.channelChevron} />
        </button>
      )}
    />
  )
}

function UpdateResult({ update, info, t, locale, onSummarize }: {
  update: UpdateInfo
  info: RuntimeInfo
  t: Translate
  locale: LocaleId
  onSummarize: () => void
}): React.ReactNode {
  if (update.upToDate) {
    return (
      <StatusCard
        state="done"
        title={t('noUpdate')}
        detail={t(update.channel === 'stable' ? 'noUpdateDescription' : 'noUpdateLatestDescription')}
      />
    )
  }
  if (!update.updateAvailable) {
    if (update.channel !== 'stable' || update.latestTag === null) {
      return <StatusCard state="done" title={t('noUpdate')} detail={t('noUpdateLatestDescription')} />
    }
    return (
      <StatusCard
        state="warning"
        title={t('tagMismatch')}
        detail={`${t('latestTag')}: ${update.latestTag}. ${t('tagMismatchDescription')}`}
      />
    )
  }
  return (
    <div style={styles.updateCard}>
      <div style={styles.statusHeading}>
        <StateDot state="warning" />
        <strong style={styles.statusTitle}>{t('updateAvailable')}</strong>
      </div>
      <dl style={styles.details}>
        {update.latestTag !== null ? (
          <>
            <dt style={styles.term}>{t('latestTag')}</dt>
            <dd style={styles.description}>{update.latestTag}</dd>
          </>
        ) : (
          <>
            <dt style={styles.term}>{t('latestBranch')}</dt>
            <dd style={styles.description}>{update.latestBranch ?? t('unknownBranch')}</dd>
          </>
        )}
        <dt style={styles.term}>{t('latestCommit')}</dt>
        <dd style={{ ...styles.description, ...styles.breakable }}>
          <CommitLink repository={info.repository} commit={update.latestCommit} title={t('viewCommit')} />
        </dd>
        <dt style={styles.term}>{t('commitTime')}</dt>
        <dd style={styles.description}>{formatCommitTime(update.latestCommitTime, locale, t)}</dd>
      </dl>
      <div style={styles.updateActions}>
        <Button variant="outline" size="sm" onClick={onSummarize}>
          {t('summarizeUpdate')}
        </Button>
      </div>
    </div>
  )
}

function StatusCard({ state, title, detail, role = 'status' }: {
  state: 'done' | 'warning' | 'ongoing' | 'error'
  title: string
  detail?: string
  role?: 'status' | 'alert'
}): React.ReactNode {
  return (
    <div style={styles.statusCard} role={role}>
      <div style={styles.statusHeading}>
        <StateDot state={state} />
        <strong style={styles.statusTitle}>{title}</strong>
      </div>
      {detail !== undefined && detail !== '' && <p style={styles.statusDetail}>{detail}</p>}
    </div>
  )
}

function UpdateSpinner(): React.ReactNode {
  return (
    <span style={styles.spinner} aria-hidden="true">
      <IconLoadingOutline16 size={16} />
    </span>
  )
}

function useSettingsLock(sectionRef: React.RefObject<HTMLElement | null>, locked: boolean): void {
  React.useEffect(() => {
    if (!locked) return
    const dialog = sectionRef.current?.closest('[role="dialog"]') as HTMLElement | null
    if (dialog === null) return

    const disabledStates = new Map<HTMLButtonElement, boolean>()
    const disableButtons = (): void => {
      for (const button of dialog.querySelectorAll<HTMLButtonElement>('button')) {
        if (!disabledStates.has(button)) disabledStates.set(button, button.disabled)
        button.disabled = true
      }
    }
    disableButtons()
    const observer = new MutationObserver(disableButtons)
    observer.observe(dialog, { childList: true, subtree: true })

    const previousBusy = dialog.getAttribute('aria-busy')
    dialog.setAttribute('aria-busy', 'true')
    const blocker = document.createElement('div')
    blocker.dataset.dshAppRuntimeLock = 'true'
    blocker.setAttribute('aria-hidden', 'true')
    Object.assign(blocker.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '2000',
      cursor: 'progress',
    })
    document.body.append(blocker)

    const blockEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    document.addEventListener('keydown', blockEscape, true)
    return () => {
      observer.disconnect()
      document.removeEventListener('keydown', blockEscape, true)
      blocker.remove()
      for (const [button, disabled] of disabledStates) button.disabled = disabled
      if (previousBusy === null) dialog.removeAttribute('aria-busy')
      else dialog.setAttribute('aria-busy', previousBusy)
    }
  }, [locked, sectionRef])
}

function CommitLink({ repository, commit, title }: {
  repository: string
  commit: string
  title: string
}): React.ReactNode {
  return (
    <a href={`${repositoryWebUrl(repository)}/commit/${commit}`} title={title} style={styles.commitLink}>
      {commit}
    </a>
  )
}

function repositoryWebUrl(repository: string): string {
  const url = new URL(repository)
  url.pathname = url.pathname.replace(/\.git$/u, '').replace(/\/$/u, '')
  return url.toString().replace(/\/$/u, '')
}

function formatCommitTime(value: string | null, locale: LocaleId, t: Translate): string {
  if (value === null) return t('unknownTime')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return t('unknownTime')
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(date)
}

function operationText(operation: OperationState, t: Translate): string {
  const keys: Record<OperationStage, RuntimeKey> = {
    preparingUpdate: 'stagePreparingUpdate',
    preparingRestore: 'stagePreparingRestore',
    syncingSource: 'stageSyncingSource',
    installingDependencies: 'stageInstallingDependencies',
    preparingToolchain: 'stagePreparingToolchain',
    compiling: 'stageCompiling',
    assembling: 'stageAssembling',
    validating: 'stageValidating',
    updateReady: 'stageUpdateReady',
    restoreReady: 'stageRestoreReady',
  }
  if (operation.stage !== undefined) return t(keys[operation.stage])
  return operation.state === 'failed' ? t('actionFailed') : ''
}

function localizedError(error: unknown, t: Translate, fallback: RuntimeKey): string {
  const message = error instanceof Error ? error.message : String(error)
  const firstLine = message.split(/\r?\n/u)[0] ?? ''
  const known: Record<string, RuntimeKey> = {
    DSH_APP_INVALID_TAG: 'invalidTag',
    DSH_APP_INVALID_COMMIT: 'invalidCommit',
    DSH_APP_INVALID_BRANCH: 'invalidBranch',
    DSH_APP_NO_BUILTIN: 'noBuiltIn',
    DSH_APP_NO_BASELINE: 'noBaseline',
    DSH_APP_NO_PENDING: 'noPendingOperation',
    DSH_APP_RESTART_UNSUPPORTED: 'restartUnsupported',
    DSH_APP_INVALID_CHANNEL: 'invalidChannel',
    DSH_APP_CONFIG_INVALID: 'configInvalid',
    DSH_APP_UNKNOWN_EDITION: 'unknownEdition',
    DSH_APP_MISSING_ENVIRONMENT: 'missingRuntimeEnvironment',
  }
  const key = known[firstLine]
  if (key !== undefined) return t(key)
  return message === '' ? t(fallback) : `${t(fallback)}: ${message}`
}

function template(value: string, values: Record<string, string>): string {
  return value.replace(/\{([a-z]+)\}/giu, (matched, key: string) => values[key] ?? matched)
}

const styles = {
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    maxWidth: 720,
    color: 'var(--dsw-alias-label-primary)',
  },
  title: {
    margin: 0,
    fontSize: 16,
    lineHeight: '24px',
    fontWeight: 500,
  },
  intro: {
    margin: 0,
    fontSize: 14,
    lineHeight: '22px',
    color: 'var(--dsw-alias-label-tertiary)',
  },
  warningCard: {
    padding: '12px 14px',
    borderRadius: 12,
    background: 'var(--dsw-alias-bg-module-platform)',
  },
  warningText: {
    margin: 0,
    fontSize: 12,
    lineHeight: '18px',
    color: 'var(--dsw-alias-state-warn-label)',
  },
  channelField: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 6,
  },
  channelLabel: {
    fontSize: 12,
    lineHeight: '18px',
    fontWeight: 500,
    color: 'var(--dsw-alias-label-secondary)',
  },
  // 与 Dsh 通用设置的语言、权限等 selector 使用同一套按钮规格。
  channelSelector: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 12,
    height: 36,
    padding: '0 14px',
    border: 'none',
    borderRadius: 18,
    background: 'var(--dsw-alias-bg-module-platform)',
    font: 'inherit',
    fontSize: 14,
    lineHeight: '22px',
    cursor: 'pointer',
    color: 'var(--dsw-alias-label-primary)',
  },
  channelChevron: {
    flex: 'none',
  },
  channelHint: {
    fontSize: 12,
    lineHeight: '18px',
    color: 'var(--dsw-alias-label-tertiary)',
  },
  runtimeCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    padding: '12px 14px',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: 12,
  },
  runtimeCardHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  updateCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    padding: '12px 14px',
    borderRadius: 12,
    background: 'var(--dsw-alias-bg-module-platform)',
  },
  updateActions: {
    display: 'flex',
    justifyContent: 'flex-end',
  },
  primaryAction: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 5,
  },
  spinner: {
    display: 'inline-flex',
    flex: 'none',
    animation: 'dsh-app-runtime-spin 800ms linear infinite',
  },
  cardTitle: {
    fontSize: 14,
    lineHeight: '22px',
    fontWeight: 500,
  },
  details: {
    display: 'grid',
    gridTemplateColumns: '112px minmax(0, 1fr)',
    gap: '8px 16px',
    margin: 0,
  },
  term: {
    margin: 0,
    fontSize: 12,
    lineHeight: '18px',
    fontWeight: 500,
    color: 'var(--dsw-alias-label-secondary)',
  },
  description: {
    margin: 0,
    fontSize: 14,
    lineHeight: '20px',
    color: 'var(--dsw-alias-label-primary)',
  },
  breakable: {
    minWidth: 0,
    overflowWrap: 'anywhere',
  },
  commitLink: {
    color: 'var(--dsw-alias-state-business-primary)',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSize: 13,
  },
  statusCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: '12px 14px',
    borderRadius: 12,
    background: 'var(--dsw-alias-bg-module-platform)',
  },
  statusHeading: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  statusTitle: {
    fontSize: 13,
    lineHeight: '20px',
    fontWeight: 500,
  },
  statusDetail: {
    margin: '0 0 0 18px',
    fontSize: 12,
    lineHeight: '18px',
    color: 'var(--dsw-alias-label-tertiary)',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  actions: {
    display: 'flex',
    alignItems: 'flex-start',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 2,
  },
} satisfies Record<string, CSSProperties>

export const inject = ['slots', 'locale', 'connection', 'sessions', 'conversation']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-app-runtime: copy dictionaries')
  const connection = ctx.get('connection') as ConnectionHandle
  const call = async <T,>(method: string, args: unknown = {}): Promise<T> => {
    const result = await connection.rpc.call('/api', `dshAppRuntime/${method}`, { args })
    if (!result.ok) throw new Error(result.error.message)
    return result.value as T
  }
  const t = ctx.locale.bind(NS) as Translate
  const writePrompt = (prompt: string): boolean => {
    const sessionId = ctx.sessions.list.getSnapshot().current
    if (sessionId === undefined) return false
    const scope = ctx.sessions.scope(sessionId)
    if (scope === undefined) return false
    ctx.conversation.input.for(scope).setDraft(prompt)
    return true
  }
  const store = new RuntimeStore(call, t, writePrompt)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dsh-app-runtime',
    order: 35,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({ store }),
  }, RuntimeSection as never))
}
