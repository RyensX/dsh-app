import '../shared/styles.css'
import { bootstrapAction } from '../shared/bootstrap'
import {
  getBootstrapInfo,
  getLaunchStatus,
  onLaunchStatus,
  openDataDirectory,
  startDsh,
} from '../shared/bridge'
import { toLaunchError, type BootstrapInfo, type LaunchStatus } from '../shared/contracts'
import { render } from '../shared/view'

const root = document.querySelector<HTMLElement>('#app')
if (!root) throw new Error('missing #app')

let info: BootstrapInfo | null = null
let status: LaunchStatus = { state: 'starting', message: 'Preparing the packaged runtime...' }

const draw = (): void => render(root, info, status, {
  edition: 'bundled',
  retry: begin,
  openDataDirectory: revealDataDirectory,
})

async function revealDataDirectory(): Promise<void> {
  try {
    await openDataDirectory()
  } catch (error) {
    status = { state: 'failed', error: toLaunchError(error, 'The data directory could not be opened') }
    draw()
  }
}

async function begin(): Promise<void> {
  status = { state: 'starting', message: 'Preparing the packaged runtime...' }
  draw()
  try {
    status = await startDsh()
  } catch (error) {
    status = { state: 'failed', error: toLaunchError(error, 'The desktop runtime did not respond') }
  }
  draw()
}

void (async () => {
  draw()
  try {
    const unlisten = await onLaunchStatus(next => {
      status = next
      draw()
    })
    window.addEventListener('beforeunload', unlisten, { once: true })
    info = await getBootstrapInfo()
    status = await getLaunchStatus()
    draw()
    const action = bootstrapAction(status)
    if (action === 'start') await begin()
    else if (action === 'navigate' && status.state === 'ready') window.location.replace(status.url)
  } catch (error) {
    status = { state: 'failed', error: toLaunchError(error, 'DSH App could not initialize') }
    draw()
  }
})()
