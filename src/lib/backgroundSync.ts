/**
 * Keep a catalog sync alive when the user leaves Jiyu and comes back.
 * Android holds a foreground service, desktop turns off window throttling,
 * and Samsung TV asks to keep the CPU. Progress is saved so a killed
 * process can finish the remaining sources on the next open.
 */

import { Capacitor, registerPlugin } from '@capacitor/core'

const JOB_KEY = 'jiyu.catalog.sync-job'

type SyncJob = { ids: string[]; done: string[] }

type CatalogSyncPlugin = {
  setActive: (options: { active: boolean }) => Promise<void>
}

const CatalogSync = registerPlugin<CatalogSyncPlugin>('CatalogSync')

type ResumeHandler = () => void

let held = false
let wakeLock: WakeLockSentinel | null = null
let resumeHandler: ResumeHandler | null = null
let visibilityBound = false

function readJob(): SyncJob | null {
  try {
    const raw = localStorage.getItem(JOB_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as SyncJob
    if (!parsed || !Array.isArray(parsed.ids) || !Array.isArray(parsed.done)) return null
    return {
      ids: parsed.ids.filter((id) => typeof id === 'string' && id.length > 0),
      done: parsed.done.filter((id) => typeof id === 'string'),
    }
  } catch {
    return null
  }
}

function writeJob(job: SyncJob): void {
  try {
    if (job.ids.length === 0 || job.ids.every((id) => job.done.includes(id))) {
      localStorage.removeItem(JOB_KEY)
      return
    }
    localStorage.setItem(JOB_KEY, JSON.stringify(job))
  } catch {
    /* private mode */
  }
}

export function rememberSyncJob(ids: string[]): void {
  const unique = [...new Set(ids.filter(Boolean))]
  if (unique.length === 0) return
  const prev = readJob()
  const done = (prev?.done ?? []).filter((id) => unique.includes(id))
  writeJob({ ids: unique, done })
}

export function noteSyncSourceFinished(id: string): void {
  const job = readJob()
  if (!job || !job.ids.includes(id)) return
  if (!job.done.includes(id)) job.done.push(id)
  writeJob(job)
}

export function clearSyncJob(): void {
  try {
    localStorage.removeItem(JOB_KEY)
  } catch {
    /* ignore */
  }
}

export function pendingSyncSourceIds(): string[] {
  const job = readJob()
  if (!job) return []
  return job.ids.filter((id) => !job.done.includes(id))
}

function tizenPower(active: boolean): void {
  const tizen = (window as unknown as { tizen?: { power?: { request?: (resource: string) => void; release?: (resource: string) => void } } }).tizen
  const power = tizen?.power
  if (!power?.request || !power.release) return
  try {
    if (active) power.request('CPU')
    else power.release('CPU')
  } catch {
    /* privilege missing or already released */
  }
}

async function screenWake(active: boolean): Promise<void> {
  try {
    if (!active) {
      await wakeLock?.release()
      wakeLock = null
      return
    }
    if (!navigator.wakeLock?.request) return
    wakeLock = await navigator.wakeLock.request('screen')
  } catch {
    wakeLock = null
  }
}

async function platformHold(active: boolean): Promise<void> {
  try {
    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
      await CatalogSync.setActive({ active })
    }
  } catch {
    /* plugin missing on an older install */
  }
  try {
    await window.signalDesktop?.setBackgroundSync?.(active)
  } catch {
    /* browser */
  }
  tizenPower(active)
  await screenWake(active)
}

/** Idempotent. A newer sync session must not drop the hold early. */
export function holdBackgroundSync(): void {
  if (held) return
  held = true
  void platformHold(true)
}

export function releaseBackgroundSync(): void {
  if (!held) return
  held = false
  void platformHold(false)
}

export function onCatalogSyncResumeRequested(handler: ResumeHandler): () => void {
  resumeHandler = handler
  return () => {
    if (resumeHandler === handler) resumeHandler = null
  }
}

function onVisible(): void {
  if (document.visibilityState !== 'visible') return
  if (held) {
    tizenPower(true)
    void screenWake(true)
  }
  resumeHandler?.()
}

export function bindBackgroundSyncResume(): void {
  if (visibilityBound || typeof document === 'undefined') return
  visibilityBound = true
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('pageshow', onVisible)
}
