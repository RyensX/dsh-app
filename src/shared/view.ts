import type { BootstrapInfo, LaunchError, LaunchStatus } from './contracts'
import { icon } from './icons'
import appIcon from '../../assets/app-icon-ui.png?url'

export type ViewActions = {
  edition: BootstrapInfo['edition']
  retry: () => void
  openDataDirectory: () => void
  extra?: HTMLElement[]
}

function retryButton(action: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'button button--primary'
  button.append(icon('RefreshCw'), document.createTextNode('Retry'))
  button.addEventListener('click', action)
  return button
}

function dataDirectoryButton(action: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'button'
  button.append(icon('FolderOpen'), document.createTextNode('Open data directory'))
  button.addEventListener('click', action)
  return button
}

function renderError(error: LaunchError, actions: ViewActions): HTMLElement {
  const fragment = document.createElement('div')
  fragment.className = 'error-content'

  const code = document.createElement('span')
  code.className = 'error-code'
  code.textContent = error.code

  const title = document.createElement('h1')
  title.textContent = error.title

  const message = document.createElement('p')
  message.className = 'message'
  message.textContent = error.message

  const details = document.createElement('details')
  details.className = 'diagnostics'
  const summary = document.createElement('summary')
  summary.append(icon('ListTree'), document.createTextNode('View diagnostics'))
  details.append(summary)
  const list = document.createElement('dl')
  for (const item of error.details) {
    const term = document.createElement('dt')
    term.textContent = item.label
    const value = document.createElement('dd')
    value.textContent = item.value
    list.append(term, value)
  }
  details.append(list)

  const buttons = document.createElement('div')
  buttons.className = 'actions'
  buttons.append(
    retryButton(actions.retry),
    dataDirectoryButton(actions.openDataDirectory),
    ...(actions.extra ?? []),
  )

  fragment.append(code, title, message, details, buttons)
  return fragment
}

export function render(root: HTMLElement, info: BootstrapInfo | null, status: LaunchStatus, actions: ViewActions): void {
  root.replaceChildren()
  const shell = document.createElement('section')
  shell.className = `shell shell--${status.state}`

  const content = document.createElement('div')
  content.className = 'content'
  const identity = document.createElement('header')
  identity.className = 'identity'
  const brand = document.createElement('div')
  brand.className = 'brand'
  const mark = document.createElement('img')
  mark.className = 'brand__mark'
  mark.src = appIcon
  mark.alt = ''
  const name = document.createElement('span')
  name.className = 'brand__name'
  name.textContent = 'DSH App'
  const edition = document.createElement('span')
  edition.className = 'edition'
  edition.textContent = (info?.edition ?? actions.edition) === 'lite' ? 'Lite' : 'Bundled'
  brand.append(mark, name, edition)
  identity.append(brand)

  if (status.state === 'failed') {
    content.append(identity, renderError(status.error, actions))
  } else {
    const launchState = document.createElement('div')
    launchState.className = 'launch-state'
    const progress = document.createElement('div')
    progress.className = 'progress'
    progress.setAttribute('aria-label', status.state === 'ready' ? 'Ready' : 'Starting')
    progress.append(icon(status.state === 'ready' ? 'CircleCheck' : 'LoaderCircle', 16))
    const copy = document.createElement('div')
    copy.className = 'launch-copy'
    const titleLine = document.createElement('div')
    titleLine.className = 'launch-title'
    const title = document.createElement('h1')
    title.textContent = status.state === 'ready' ? 'Ready' : 'Starting'
    const message = document.createElement('p')
    message.className = 'message'
    message.textContent = status.state === 'ready' ? status.url : status.message
    titleLine.append(title, progress)
    copy.append(titleLine, message)
    launchState.append(copy)
    identity.append(launchState)
    content.append(identity)
  }

  const footer = document.createElement('footer')
  footer.textContent = info ? `v${info.appVersion}` : ''
  shell.append(content, footer)
  root.append(shell)
}
