/**
 * On-Device Stream Reliability & Mirror Learning Engine.
 *
 * Tracks probe outcomes, playback longevity, latency, and buffer stalls
 * per provider (e.g. 'admin', 'delta', 'echo') and hostname. Uses Bayesian
 * Laplace smoothing and exponential latency decay so the app automatically
 * favors the highest-performing streams on the user's specific network/ISP.
 */

const STORAGE_KEY = 'jiyu.stream.learning.v1'
const MAX_TRACKED_PROVIDERS = 120

export type PlaybackHealthEvent = 'started' | 'sustained' | 'stall' | 'fatal'

export interface StreamProviderStats {
  id: string
  successCount: number
  failureCount: number
  stallCount: number
  sustainedPlayCount: number
  totalLatencyMs: number
  latencySamples: number
  avgLatencyMs: number
  lastTestedAt: number
  lastOutcome: 'ok' | 'fail'
  score: number // Composite score from 0.0 to 1.0
}

/** Extract a clean provider tag or domain from a source name or URL */
export function normalizeProviderKey(urlOrProvider: string): string {
  if (!urlOrProvider) return 'unknown'
  const trimmed = urlOrProvider.trim()
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed)
      return parsed.hostname.toLowerCase()
    } catch {
      return trimmed.toLowerCase()
    }
  }
  return trimmed.toLowerCase()
}

function loadStatsMap(): Record<string, StreamProviderStats> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, StreamProviderStats>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function saveStatsMap(map: Record<string, StreamProviderStats>) {
  try {
    // Keep map bounded to prevent unbounded storage growth
    const entries = Object.entries(map)
    if (entries.length > MAX_TRACKED_PROVIDERS) {
      entries.sort((a, b) => b[1].lastTestedAt - a[1].lastTestedAt)
      const trimmed = Object.fromEntries(entries.slice(0, MAX_TRACKED_PROVIDERS))
      localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed))
      return
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    /* ignore storage quota */
  }
}

/**
 * Compute composite Bayesian reliability score (0.0 to 1.0).
 * Balances success/failure ratio with Laplace smoothing, latency penalty,
 * and buffering stall penalties.
 */
function computeScore(stats: StreamProviderStats): number {
  const successes = stats.successCount + stats.sustainedPlayCount * 2
  const failures = stats.failureCount * 2 + stats.stallCount * 1.5
  
  // Laplace smoothing with prior favoring cautious optimism (2 successes / 2 failures)
  const baseRatio = (successes + 2) / (successes + failures + 4)

  // Latency multiplier: 1.0 at <= 200ms, down to 0.7 at 3000ms+
  const latency = stats.avgLatencyMs > 0 ? stats.avgLatencyMs : 800
  const latencyFactor = Math.max(0.65, Math.min(1.0, 1.05 - latency / 6000))

  // Stall penalty: high stall counts degrade reliability
  const stallFactor = Math.max(0.5, 1.0 - (stats.stallCount * 0.1))

  // Penalty for consecutive immediate failures within the last 5 minutes
  const isRecentFailure =
    stats.lastOutcome === 'fail' && Date.now() - stats.lastTestedAt < 5 * 60 * 1000
  const recentFailPenalty = isRecentFailure ? 0.8 : 1.0

  return Math.max(0.05, Math.min(0.99, baseRatio * latencyFactor * stallFactor * recentFailPenalty))
}

/**
 * Record the result of a network probe (HTTP / HLS probe).
 */
export function recordStreamProbeResult(
  urlOrProvider: string,
  ok: boolean,
  latencyMs: number,
) {
  const key = normalizeProviderKey(urlOrProvider)
  if (!key || key === 'unknown') return

  const map = loadStatsMap()
  const existing = map[key] || {
    id: key,
    successCount: 0,
    failureCount: 0,
    stallCount: 0,
    sustainedPlayCount: 0,
    totalLatencyMs: 0,
    latencySamples: 0,
    avgLatencyMs: 0,
    lastTestedAt: 0,
    lastOutcome: 'ok',
    score: 0.5,
  }

  if (ok) {
    existing.successCount += 1
    existing.lastOutcome = 'ok'
  } else {
    existing.failureCount += 1
    existing.lastOutcome = 'fail'
  }

  if (latencyMs > 0 && Number.isFinite(latencyMs)) {
    existing.totalLatencyMs += latencyMs
    existing.latencySamples += 1
    // Exponential moving average (EMA)
    existing.avgLatencyMs = Math.round(
      existing.avgLatencyMs > 0
        ? existing.avgLatencyMs * 0.7 + latencyMs * 0.3
        : latencyMs,
    )
  }

  existing.lastTestedAt = Date.now()
  existing.score = Number(computeScore(existing).toFixed(3))
  map[key] = existing
  saveStatsMap(map)
}

/**
 * Record live playback health telemetry (sustained playback, buffer stalls, fatal errors).
 */
export function recordPlaybackHealth(
  urlOrProvider: string,
  event: PlaybackHealthEvent,
) {
  const key = normalizeProviderKey(urlOrProvider)
  if (!key || key === 'unknown') return

  const map = loadStatsMap()
  const existing = map[key] || {
    id: key,
    successCount: 0,
    failureCount: 0,
    stallCount: 0,
    sustainedPlayCount: 0,
    totalLatencyMs: 0,
    latencySamples: 0,
    avgLatencyMs: 0,
    lastTestedAt: 0,
    lastOutcome: 'ok',
    score: 0.5,
  }

  existing.lastTestedAt = Date.now()

  switch (event) {
    case 'started':
      existing.successCount += 1
      existing.lastOutcome = 'ok'
      break
    case 'sustained':
      // Played for >30-60s with good stability
      existing.sustainedPlayCount += 1
      existing.lastOutcome = 'ok'
      break
    case 'stall':
      // Reached empty buffer mid-stream
      existing.stallCount += 1
      break
    case 'fatal':
      // Unrecoverable HLS or media decode error
      existing.failureCount += 1
      existing.lastOutcome = 'fail'
      break
  }

  existing.score = Number(computeScore(existing).toFixed(3))
  map[key] = existing
  saveStatsMap(map)
}

/**
 * Get learned reliability score for a provider or host (0.0 to 1.0).
 * Defaults to 0.5 for newly discovered providers.
 */
export function getLearnedStreamScore(urlOrProvider: string): number {
  const key = normalizeProviderKey(urlOrProvider)
  const map = loadStatsMap()
  return map[key]?.score ?? 0.5
}

/**
 * Get detailed stats for a provider or host, if recorded.
 */
export function getProviderStats(urlOrProvider: string): StreamProviderStats | null {
  const key = normalizeProviderKey(urlOrProvider)
  const map = loadStatsMap()
  return map[key] || null
}

/**
 * Rank a list of stream sources by learned reliability scores.
 * Prioritizes known reliable sources on this network, breaking ties with default order.
 */
export function rankSourcesWithLearning<T extends { source: string; id?: string }>(
  sources: T[],
): T[] {
  if (sources.length <= 1) return sources
  const map = loadStatsMap()

  return [...sources].sort((a, b) => {
    const keyA = normalizeProviderKey(a.source)
    const keyB = normalizeProviderKey(b.source)

    // Known static biases as prior
    const defaultBias = (name: string) => {
      if (name === 'admin' || name === 'delta') return 0.05
      if (name === 'echo') return -0.15
      return 0
    }

    const scoreA = (map[keyA]?.score ?? 0.5) + defaultBias(keyA)
    const scoreB = (map[keyB]?.score ?? 0.5) + defaultBias(keyB)

    if (Math.abs(scoreB - scoreA) >= 0.02) {
      return scoreB - scoreA
    }
    return (a.id || '').localeCompare(b.id || '')
  })
}
