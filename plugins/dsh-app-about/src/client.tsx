import * as React from 'react'
import type { CSSProperties } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button,
  IconDownloadOutline16,
  IconLoadingOutline16,
  StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import appIcon from '../../../assets/app-icon-ui.png'
import { en, zh, type AboutKey } from './locales.ts'

const NS = 'settings.dshAppAbout'
const BACKGROUND_CHECK_WAKE_MS = 60 * 60 * 1000
const POST_STARTUP_DELAY_MS = 1_500

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.dshAppAbout': AboutKey
  }
}

type Translate = (key: AboutKey) => string

type ReleaseInfo = {
  tag: string
  version: string
  name: string
  body: string
  url: string
  publishedAt: string | null
  assets: string[]
}

type UpdateSnapshot = {
  currentVersion: string
  checkedAt: string | null
  dismissed: boolean
  release: ReleaseInfo | null
  updateAvailable: boolean
}

type ViewSnapshot = {
  currentVersion: string | null
  backgroundUpdate: UpdateSnapshot | null
  manualUpdate: UpdateSnapshot | null
  manualChecking: boolean
  installing: boolean
  manualError: string | null
}

class AboutStore {
  private snapshot: ViewSnapshot = {
    currentVersion: null,
    backgroundUpdate: null,
    manualUpdate: null,
    manualChecking: false,
    installing: false,
    manualError: null,
  }
  private readonly listeners = new Set<() => void>()
  private manualRequest = 0

  constructor(
    private readonly call: <T>(method: string, args?: unknown) => Promise<T>,
    private readonly t: Translate,
  ) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  readonly getSnapshot = (): ViewSnapshot => this.snapshot

  beginManualSession(): void {
    this.resetManualSession()
  }

  endManualSession(): void {
    this.resetManualSession()
  }

  async loadInfo(): Promise<void> {
    try {
      const info = await this.call<{ currentVersion: string }>('info')
      this.snapshot = { ...this.snapshot, currentVersion: info.currentVersion }
      this.emit()
    } catch {
      // 本地版本读取失败时，后续更新检查仍会返回同一字段。
    }
  }

  async refreshManual(): Promise<void> {
    const request = ++this.manualRequest
    this.snapshot = {
      ...this.snapshot,
      manualUpdate: null,
      manualChecking: true,
      installing: false,
      manualError: null,
    }
    this.emit()
    try {
      const update = await this.call<UpdateSnapshot>('checkUpdate', { force: true })
      if (request !== this.manualRequest) return
      this.snapshot = {
        currentVersion: update.currentVersion,
        backgroundUpdate: update,
        manualUpdate: update,
        manualChecking: false,
        installing: false,
        manualError: null,
      }
      this.emit()
    } catch (error) {
      if (request !== this.manualRequest) return
      this.snapshot = {
        ...this.snapshot,
        manualChecking: false,
        manualError: localizedError(error, this.t),
      }
      this.emit()
    }
  }

  async installUpdate(tag: string): Promise<void> {
    if (this.snapshot.installing) return
    this.snapshot = { ...this.snapshot, installing: true, manualError: null }
    this.emit()
    try {
      await this.call<void>('installUpdate', { tag })
      this.snapshot = { ...this.snapshot, installing: false }
      this.emit()
    } catch (error) {
      this.snapshot = {
        ...this.snapshot,
        installing: false,
        manualError: localizedError(error, this.t),
      }
      this.emit()
    }
  }

  async refreshAutomatic(force: boolean): Promise<void> {
    try {
      const update = await this.call<UpdateSnapshot>('checkUpdate', { force })
      this.snapshot = {
        ...this.snapshot,
        currentVersion: update.currentVersion,
        backgroundUpdate: update,
      }
      this.emit()
    } catch {
      // 自动检查只负责更新侧边栏提醒，失败不会进入“关于”页的手动检查状态。
    }
  }

  dismiss(tag: string): void {
    const current = this.snapshot.backgroundUpdate
    if (current?.release?.tag !== tag) return
    this.snapshot = {
      ...this.snapshot,
      backgroundUpdate: { ...current, dismissed: true },
    }
    this.emit()
    void this.call<UpdateSnapshot>('dismissUpdate', { tag }).catch(() => {
      // 浏览器已经打开；持久化失败不应打断用户的跳转操作。
    })
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  private resetManualSession(): void {
    this.manualRequest += 1
    this.snapshot = {
      ...this.snapshot,
      manualUpdate: null,
      manualChecking: false,
      installing: false,
      manualError: null,
    }
    this.emit()
  }
}

type AboutSectionProps = PropsRuntime<'settings.section'> & PropsLocale<typeof NS> & {
  store: AboutStore
}

function AboutSection({ store, t }: AboutSectionProps): React.ReactNode {
  const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
  React.useLayoutEffect(() => {
    // 每次进入“关于”都是新的手动检查会话；这里只读取本地版本，不发起更新检查。
    store.beginManualSession()
    void store.loadInfo()
    return () => { store.endManualSession() }
  }, [store])
  const update = state.manualUpdate
  const locale = document.documentElement.lang.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'

  return (
    <section style={styles.section} data-dsh-app-about="settings">
      <style>{aboutStyles}</style>
      <h2 style={styles.title}>{t('title')}</h2>

      <div style={styles.identity}>
        <img src={appIcon} alt="" width={128} height={128} style={styles.appIcon} />
        <div style={styles.identityCopy}>
          <strong style={styles.appName}>{t('appName')}</strong>
          <span style={styles.version}>
            {format(t('version'), { version: state.currentVersion ?? update?.currentVersion ?? '…' })}
          </span>
          <a
            href="https://github.com/RyensX/dsh-app"
            target="_blank"
            rel="noopener noreferrer"
            style={styles.repositoryLink}
          >
            <GitHubIcon />
            <span>github.com/RyensX/dsh-app</span>
          </a>
        </div>
      </div>

      {update?.updateAvailable === true && update.release !== null ? (
        <ReleaseCard
          release={update.release}
          locale={locale}
          installing={state.installing}
          t={t}
          onInstall={() => { void store.installUpdate(update.release?.tag ?? '') }}
        />
      ) : update !== null ? (
        <StatusCard
          state="done"
          title={t('upToDate')}
          detail={format(t('upToDateDetail'), { version: update.currentVersion })}
        />
      ) : null}

      {state.manualError !== null && <StatusCard state="error" title={state.manualError} role="alert" />}

      <div style={styles.actions}>
        <Button
          variant="outline"
          disabled={state.manualChecking || state.installing}
          onClick={() => { void store.refreshManual() }}
        >
          {state.manualChecking ? (
            <span style={styles.loadingLabel}>
              <span style={styles.spinner}><IconLoadingOutline16 size={16} /></span>
              {t('checking')}
            </span>
          ) : t('checkUpdate')}
        </Button>
      </div>
    </section>
  )
}

function ReleaseCard({ release, locale, installing, t, onInstall }: {
  release: ReleaseInfo
  locale: string
  installing: boolean
  t: Translate
  onInstall: () => void
}): React.ReactNode {
  return (
    <div style={styles.releaseCard}>
      <div style={styles.statusHeading}>
        <StateDot state="warning" />
        <strong style={styles.statusTitle}>{t('updateAvailable')}</strong>
      </div>
      <dl style={styles.details}>
        <dt style={styles.term}>{t('latestVersion')}</dt>
        <dd style={styles.description}>{release.name === release.tag ? release.tag : `${release.name} (${release.tag})`}</dd>
        <dt style={styles.term}>{t('publishedAt')}</dt>
        <dd style={styles.description}>{formatDate(release.publishedAt, locale)}</dd>
      </dl>
      <div>
        <strong style={styles.releaseNotesTitle}>{t('releaseNotes')}</strong>
        <p style={styles.releaseNotes}>{release.body.trim() || t('emptyReleaseNotes')}</p>
      </div>
      <div style={styles.releaseActions}>
        <Button variant="primary" disabled={installing} onClick={onInstall}>
          {installing ? (
            <span style={styles.loadingLabel}>
              <span style={styles.spinner}><IconLoadingOutline16 size={16} /></span>
              {t('preparingUpdate')}
            </span>
          ) : t('update')}
        </Button>
        <Button variant="outline" onClick={() => { openRelease(release.url) }}>
          {t('detailedLogs')}
        </Button>
      </div>
    </div>
  )
}

type UpdateEntryProps = PropsRuntime<'sidebar.footer.action'> & PropsLocale<typeof NS> & {
  store: AboutStore
}

function UpdateEntry({ wide, store, t }: UpdateEntryProps): React.ReactNode {
  const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
  const release = state.backgroundUpdate?.release
  if (state.backgroundUpdate?.updateAvailable !== true
    || state.backgroundUpdate.dismissed
    || release === null
    || release === undefined) {
    return null
  }
  return (
    <div style={wide ? styles.footerLayer : { ...styles.footerLayer, ...styles.footerLayerRail }}>
      <button
        type="button"
        data-dsh-app-about-update-entry="true"
        style={wide ? styles.footerButton : { ...styles.footerButton, ...styles.footerButtonRail }}
        aria-label={t('sidebarUpdateAria')}
        title={wide ? undefined : t('sidebarUpdate')}
        onClick={() => {
          store.dismiss(release.tag)
          openRelease(release.url)
        }}
      >
        <IconDownloadOutline16 size={wide ? 16 : 18} />
        {wide && <span style={styles.footerLabel}>{t('sidebarUpdate')}</span>}
      </button>
    </div>
  )
}

function StatusCard({ state, title, detail, role = 'status' }: {
  state: 'done' | 'error'
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
      {detail !== undefined && <p style={styles.statusDetail}>{detail}</p>}
    </div>
  )
}

function GitHubIcon(): React.ReactNode {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      style={styles.githubIcon}
    >
      <path d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.11.79-.25.79-.56v-2.23c-3.22.7-3.9-1.37-3.9-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.71.08-.71 1.16.08 1.78 1.2 1.78 1.2 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.74-1.55-2.57-.29-5.27-1.29-5.27-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.47.11-3.05 0 0 .97-.31 3.16 1.18A10.98 10.98 0 0 1 12 6.11c.98 0 1.95.13 2.87.39 2.2-1.49 3.16-1.18 3.16-1.18.63 1.58.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.71 5.39-5.29 5.68.42.36.79 1.07.79 2.16v3.25c0 .31.21.68.8.56A11.5 11.5 0 0 0 12 .7Z" />
    </svg>
  )
}

function openRelease(url: string): void {
  window.location.assign(url)
}

function formatDate(value: string | null, locale: string): string {
  if (value === null) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function localizedError(error: unknown, t: Translate): string {
  const message = error instanceof Error ? error.message : String(error)
  const firstLine = message.split(/\r?\n/u)[0] ?? ''
  const known: Record<string, AboutKey> = {
    DSH_APP_UPDATE_STATE_INVALID: 'invalidState',
    DSH_APP_RELEASE_INVALID: 'invalidRelease',
    DSH_APP_UPDATE_REQUEST_FAILED: 'requestFailed',
    DSH_APP_UPDATE_ASSET_MISSING: 'assetMissing',
    DSH_APP_UPDATE_DOWNLOAD_FAILED: 'downloadFailed',
    DSH_APP_UPDATE_OPEN_FAILED: 'openInstallerFailed',
    DSH_APP_UPDATE_RELEASE_STALE: 'releaseStale',
    DSH_APP_UPDATE_NOT_AVAILABLE: 'upToDate',
    DSH_APP_UPDATE_TARGET_INVALID: 'targetInvalid',
    DSH_APP_MISSING_ENVIRONMENT: 'missingEnvironment',
  }
  const key = known[firstLine]
  return key === undefined ? `${t('checkFailed')}: ${firstLine}` : t(key)
}

function format(value: string, values: Record<string, string>): string {
  return value.replace(/\{([a-z]+)\}/giu, (matched, key: string) => values[key] ?? matched)
}

const aboutStyles = `
@keyframes dsh-app-about-spin { to { transform: rotate(360deg); } }
[data-dsh-app-about-update-entry]:hover { background: var(--dsw-alias-interactive-bg-hover) !important; }
`

const styles = {
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    maxWidth: 720,
    color: 'var(--dsw-alias-label-primary)',
  },
  title: {
    margin: 0,
    fontSize: 16,
    lineHeight: '24px',
    fontWeight: 500,
  },
  identity: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: '20px 0 12px',
  },
  appIcon: {
    flex: 'none',
    borderRadius: 20,
  },
  identityCopy: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 5,
    minWidth: 0,
  },
  appName: {
    fontSize: 18,
    lineHeight: '26px',
    fontWeight: 600,
  },
  version: {
    fontSize: 13,
    lineHeight: '20px',
    color: 'var(--dsw-alias-label-tertiary)',
  },
  repositoryLink: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    marginTop: 5,
    color: 'var(--dsw-alias-state-business-primary)',
    fontSize: 13,
    lineHeight: '20px',
    textDecoration: 'none',
  },
  githubIcon: {
    flex: 'none',
  },
  releaseCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    padding: '14px 16px',
    borderRadius: 12,
    background: 'var(--dsw-alias-bg-module-platform)',
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
  },
  details: {
    display: 'grid',
    gridTemplateColumns: '96px minmax(0, 1fr)',
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
    minWidth: 0,
    fontSize: 14,
    lineHeight: '20px',
    overflowWrap: 'anywhere',
  },
  releaseNotesTitle: {
    display: 'block',
    marginBottom: 6,
    fontSize: 12,
    lineHeight: '18px',
    fontWeight: 500,
    color: 'var(--dsw-alias-label-secondary)',
  },
  releaseNotes: {
    maxHeight: 240,
    margin: 0,
    padding: '10px 12px',
    overflowY: 'auto',
    borderRadius: 10,
    background: 'var(--dsw-alias-bg-base)',
    fontSize: 13,
    lineHeight: '20px',
    color: 'var(--dsw-alias-label-primary)',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  releaseActions: {
    display: 'flex',
    justifyContent: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  actions: {
    display: 'flex',
    justifyContent: 'center',
  },
  loadingLabel: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
  },
  spinner: {
    display: 'inline-flex',
    animation: 'dsh-app-about-spin 800ms linear infinite',
  },
  footerLayer: {
    display: 'flex',
    alignItems: 'center',
    width: '100%',
    height: 42,
    margin: '8px 0 0',
  },
  footerLayerRail: {
    width: 36,
    height: 36,
    margin: 0,
  },
  footerButton: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    width: 'calc(100% + 4px)',
    height: 42,
    margin: '0 -2px',
    padding: '0 10px 0 8px',
    border: 'none',
    borderRadius: 12,
    background: 'transparent',
    color: 'var(--dsw-alias-label-primary)',
    font: 'inherit',
    fontSize: 14,
    cursor: 'pointer',
    overflow: 'hidden',
  },
  footerButtonRail: {
    justifyContent: 'center',
    gap: 0,
    width: 36,
    height: 36,
    margin: 0,
    padding: 0,
    borderRadius: '50%',
  },
  footerLabel: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
} satisfies Record<string, CSSProperties>

export const inject = ['slots', 'locale', 'connection']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-app-about: copy dictionaries')
  const connection = ctx.get('connection') as ConnectionHandle
  const call = async <T,>(method: string, args: unknown = {}): Promise<T> => {
    const result = await connection.rpc.call('/api', `dshAppAbout/${method}`, { args })
    if (!result.ok) throw new Error(result.error.message)
    return result.value as T
  }
  const t = ctx.locale.bind(NS) as Translate
  const store = new AboutStore(call, t)

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dsh-app-about',
    order: 100,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({ store }),
  }, AboutSection as never))

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'dsh-app-update',
    order: 10,
    label: () => t('sidebarUpdate'),
    locale: NS,
    inject: () => ({ store }),
  }, UpdateEntry as never))

  ctx.effect(() => {
    let startupTimer: number | undefined
    let dailyTimer: number | undefined
    const startChecks = (): void => {
      // 首屏与插件槽位都完成装载后才发请求，更新检查不进入 App 启动关键路径。
      startupTimer = window.setTimeout(() => {
        void store.refreshAutomatic(true)
        dailyTimer = window.setInterval(() => {
          void store.refreshAutomatic(false)
        }, BACKGROUND_CHECK_WAKE_MS)
      }, POST_STARTUP_DELAY_MS)
    }
    if (document.readyState === 'complete') startChecks()
    else window.addEventListener('load', startChecks, { once: true })
    return () => {
      window.removeEventListener('load', startChecks)
      if (startupTimer !== undefined) window.clearTimeout(startupTimer)
      if (dailyTimer !== undefined) window.clearInterval(dailyTimer)
    }
  }, 'dsh-app-about: post-startup update checks')
}
