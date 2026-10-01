import type { StreamItem, StreamProbeResult } from '../types'
import { getPerformanceKnobs } from './deviceProfile'
import { isStreamedCatalogItem } from './streamed'
import { isYouTubeUrl } from './webBrowser'
import { isYouTubeLiveNow } from './youtubeLive'
import { recordStreamProbeResult } from './streamLearning'

/** Fast fail — unresponsive streams shouldn't stall the whole shelf */
export const DEFAULT_TIMEOUT_MS = 2500
/** Fallback when the device profile has not resolved yet. */
export const DEFAULT_CONCURRENCY = 20
const CHUNK_SIZE = 16

function probeConcurrency(): number {
  return getPerformanceKnobs().streamProbeConcurrency || DEFAULT_CONCURRENCY
}

async function probeYouTubeLive(url: string): Promise<StreamProbeResult> {
  const started = Date.now()
  try {
    const live = await isYouTubeLiveNow(url)
    return {
      ok: live,
      state: live ? 'online' : 'offline',
      status: live ? 200 : 0,
      latencyMs: Date.now() - started,
      error: live ? '' : 'Not live on YouTube right now',
    }
  } catch (err) {
    return {
      ok: false,
      state: 'offline',
      status: 0,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

async function probeInBrowser(url: string, timeoutMs: number): Promise<StreamProbeResult> {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { Range: 'bytes=0-2047' },
      mode: 'cors',
    })
    clearTimeout(timer)
    if (response.ok || response.status === 206) {
      return {
        ok: true,
        state: 'online',
        status: response.status,
        latencyMs: Date.now() - started,
        error: '',
      }
    }
    return {
      ok: false,
      state: 'offline',
      status: response.status,
      latencyMs: Date.now() - started,
      error: `HTTP ${response.status}`,
    }
  } catch (err) {
    clearTimeout(timer)
    const aborted = err instanceof Error && err.name === 'AbortError'
    return {
      ok: false,
      state: aborted ? 'timeout' : 'offline',
      status: 0,
      latencyMs: Date.now() - started,
      error: aborted ? 'Timed out' : err instanceof Error ? err.message : String(err),
    }
  }
}

export async function probeStreamUrl(
  url: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<StreamProbeResult> {
  let res: StreamProbeResult
  if (isYouTubeUrl(url)) {
    res = await probeYouTubeLive(url)
  } else if (window.signalDesktop?.probeStream) {
    res = await window.signalDesktop.probeStream(url, timeoutMs)
  } else {
    res = await probeInBrowser(url, timeoutMs)
  }
  recordStreamProbeResult(url, res.ok, res.latencyMs)
  return res
}

export type ProbeProgress = { id: string } & StreamProbeResult

/**
 * Probes in chunks so the UI can hide dead streams as results arrive.
 */
export async function probeStreamItems(
  items: StreamItem[],
  options?: {
    timeoutMs?: number
    concurrency?: number
    onChunk?: (results: ProbeProgress[]) => void
  },
): Promise<ProbeProgress[]> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const all: ProbeProgress[] = []

  for (let offset = 0; offset < items.length; offset += CHUNK_SIZE) {
    const slice = items.slice(offset, offset + CHUNK_SIZE)
    const entries = slice.map((item) => ({ id: item.id, url: item.url }))

    const chunk = await mapPool(entries, options?.concurrency ?? probeConcurrency(), async (entry) => {
      const item = slice.find((row) => row.id === entry.id)
      // Live Streamed embeds — treat as online (homepage URL is not an HLS probe).
      if (item && isStreamedCatalogItem(item)) {
        return {
          id: entry.id,
          ok: true,
          state: 'online' as const,
          status: 200,
          latencyMs: 0,
          error: '',
        }
      }
      let probeRes: StreamProbeResult
      if (isYouTubeUrl(entry.url)) {
        probeRes = await probeYouTubeLive(entry.url)
      } else if (window.signalDesktop?.probeStream) {
        probeRes = await window.signalDesktop.probeStream(entry.url, timeoutMs)
      } else {
        probeRes = await probeInBrowser(entry.url, timeoutMs)
      }
      recordStreamProbeResult(entry.url, probeRes.ok, probeRes.latencyMs)
      return { id: entry.id, ...probeRes }
    })

    all.push(...chunk)
    options?.onChunk?.(chunk)
  }

  return all
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0

  async function run() {
    while (cursor < items.length) {
      const i = cursor++
      results[i] = await worker(items[i], i)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, () => run()),
  )
  return results
}
