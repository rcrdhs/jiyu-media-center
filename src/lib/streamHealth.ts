import type { StreamItem, StreamProbeResult } from '../types'

/** Fast fail — unresponsive streams shouldn't stall the whole shelf */
export const DEFAULT_TIMEOUT_MS = 2500
export const DEFAULT_CONCURRENCY = 20
const CHUNK_SIZE = 16

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
  if (window.signalDesktop?.probeStream) {
    return window.signalDesktop.probeStream(url, timeoutMs)
  }
  return probeInBrowser(url, timeoutMs)
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

    let chunk: ProbeProgress[]
    if (window.signalDesktop?.probeStreams) {
      chunk = await window.signalDesktop.probeStreams(entries, timeoutMs)
    } else {
      chunk = await mapPool(entries, options?.concurrency ?? DEFAULT_CONCURRENCY, async (entry) => {
        const probe = await probeInBrowser(entry.url, timeoutMs)
        return { id: entry.id, ...probe }
      })
    }

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
