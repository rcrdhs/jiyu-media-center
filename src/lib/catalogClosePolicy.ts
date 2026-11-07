/**
 * Resume rules for a catalog job saved in local storage.
 * Native sets `closedByAppExit` when Jiyu actually closes (PiP dismiss,
 * Back→exit, Recents swipe). Home into PiP and expanding PiP do not.
 * A closed job is not resumed; the existing catalog is left as it was.
 */
export function shouldResumePendingCatalog(opts: {
  closedByAppExit: boolean
  pendingSourceIds: readonly string[]
  syncAlreadyRunning: boolean
}): boolean {
  if (opts.closedByAppExit || opts.syncAlreadyRunning) return false
  return opts.pendingSourceIds.some((id) => typeof id === 'string' && id.length > 0)
}
