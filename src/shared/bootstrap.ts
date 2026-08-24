import type { LaunchStatus } from './contracts'

export type BootstrapAction = 'start' | 'navigate' | 'wait'

export function bootstrapAction(status: LaunchStatus): BootstrapAction {
  if (status.state === 'starting') return 'start'
  if (status.state === 'ready') return 'navigate'
  return 'wait'
}
