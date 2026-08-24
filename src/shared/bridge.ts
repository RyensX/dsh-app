import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { BootstrapInfo, LaunchStatus } from './contracts'

export const getBootstrapInfo = (): Promise<BootstrapInfo> => invoke('get_bootstrap_info')

export const getLaunchStatus = (): Promise<LaunchStatus> => invoke('get_launch_status')

export const startDsh = (): Promise<LaunchStatus> => invoke('start_dsh')

export const stopDsh = (): Promise<void> => invoke('stop_dsh')

export const openDataDirectory = (): Promise<void> => invoke('open_data_directory')

export const onLaunchStatus = (
  handler: (status: LaunchStatus) => void,
): Promise<UnlistenFn> => listen<LaunchStatus>('dsh-status', event => handler(event.payload))
