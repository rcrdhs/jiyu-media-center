/**
 * Whether the desktop Jiyu menu should show "Restart dev app".
 * Visibility only. Packaged builds also refuse the IPC in the main process.
 * Android / TV shells and plain web (no Electron preload) stay unchanged.
 */
export function shouldOfferDevAppRestart(input: {
  devBuild: boolean
  androidShell: boolean
  desktopBridge: boolean
}): boolean {
  return input.devBuild === true && input.androidShell !== true && input.desktopBridge === true
}

export function devRestartFailureNote(reason: string | undefined): string {
  switch (reason) {
    case 'already-scheduled':
      return 'Restart already in progress.'
    case 'packaged':
    case 'packaged-entry':
    case 'not-dev-electron':
    case 'argv-exec-mismatch':
      return 'Restart is only available in the development Electron app.'
    case 'missing-app-entry':
      return 'This Electron process was not started with the dev app path.'
    case 'relaunch-failed':
      return 'Could not schedule a restart. This dev app is still running.'
    case 'quit-failed':
      return 'Restart is scheduled and will finish when this dev app exits.'
    default:
      return 'Could not restart the dev app.'
  }
}
