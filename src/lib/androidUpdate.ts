/**
 * Android sideload updates from the GitHub Release feed (latest-android.yml).
 * Desktop updates stay on electron-updater.
 */

import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'

export type AndroidUpdateProgress = {
  percent: number
  transferred: number
  total: number
}

type AppUpdatePlugin = {
  check: () => Promise<{
    ok: boolean
    updateAvailable: boolean
    version: string
    versionCode: number
    installedVersionCode: number
  }>
  download: () => Promise<{ ok: boolean; version?: string }>
  install: () => Promise<{ ok: boolean; reason?: string }>
  addListener: (
    eventName: 'progress',
    listenerFunc: (event: AndroidUpdateProgress) => void,
  ) => Promise<PluginListenerHandle>
}

const AppUpdate = registerPlugin<AppUpdatePlugin>('AppUpdate')

export function androidCheckForUpdate() {
  return AppUpdate.check()
}

export function androidDownloadUpdate() {
  return AppUpdate.download()
}

export function androidInstallUpdate() {
  return AppUpdate.install()
}

export function onAndroidUpdateProgress(
  listener: (event: AndroidUpdateProgress) => void,
): Promise<PluginListenerHandle> {
  return AppUpdate.addListener('progress', listener)
}
