import {
  FolderOpen,
  PackageOpen,
  X,
  createElement,
  type IconNode,
} from 'lucide'

const nodes = { FolderOpen, PackageOpen, X } satisfies Record<string, IconNode>
type SystemIcon = keyof typeof nodes

function systemIcon(name: SystemIcon): SVGElement {
  return createElement(nodes[name], {
    width: 16,
    height: 16,
    'stroke-width': 1.8,
    'aria-hidden': 'true',
  })
}

function actionButton(label: string, iconName: SystemIcon, action: () => void, primary = false): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = primary ? 'button button--primary' : 'button'
  button.append(systemIcon(iconName), document.createTextNode(label))
  button.addEventListener('click', action)
  return button
}

export function liteActions(chooseNode: () => void): HTMLElement[] {
  return [
    actionButton('Choose Node', 'FolderOpen', chooseNode),
    actionButton('Use Bundled', 'PackageOpen', showBundledAdvice),
  ]
}

function showBundledAdvice(): void {
  const dialog = document.createElement('dialog')
  dialog.className = 'advice-dialog'
  const title = document.createElement('h2')
  title.textContent = 'Use the Bundled installer'
  const body = document.createElement('p')
  body.textContent = 'Install the Bundled edition from the same DSH App release. It replaces Lite and keeps your existing profile and sessions.'
  const close = actionButton('Close', 'X', () => dialog.close(), true)
  dialog.append(title, body, close)
  dialog.addEventListener('close', () => dialog.remove())
  document.body.append(dialog)
  dialog.showModal()
}
