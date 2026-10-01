/**
 * Desktop opt-in subtitle auto-sync experiment.
 *
 * Estimates a constant delay (same sign as Player Subs − / +: positive = later)
 * by sampling mid-episode cues, capturing audio, finding a speech energy onset
 * near each cue (delay = speechTime − cue.start), then taking the median.
 *
 * Desktop-only — Android/TV keep manual sync.
 */

import type { SubtitleCue } from './subtitles'

export type AutoSyncResult =
  | { ok: true; delaySec: number; samples: number; method: 'energy-onset' }
  | { ok: false; error: string }

type VideoAudioTap = {
  ctx: AudioContext
  source: MediaElementAudioSourceNode
}

const taps = new WeakMap<HTMLVideoElement, VideoAudioTap>()

const SKIP_OP_SEC = 90
const PRE_ROLL_SEC = 1.5
const CAPTURE_SEC = 4
const MAX_ABS_DELAY = 10
const MIN_SAMPLES = 2
const MAX_SAMPLES = 5

export function isSubtitleAutoSyncAvailable(): boolean {
  return Boolean(typeof window !== 'undefined' && window.signalDesktop)
}

function ensureTap(video: HTMLVideoElement): VideoAudioTap {
  const existing = taps.get(video)
  if (existing) return existing
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  const ctx = new Ctx()
  const source = ctx.createMediaElementSource(video)
  // Keep playback audible.
  source.connect(ctx.destination)
  const tap = { ctx, source }
  taps.set(video, tap)
  return tap
}

function pickSampleCues(cues: SubtitleCue[], durationSec: number): SubtitleCue[] {
  const endCeil = durationSec > 120 ? durationSec - 45 : Number.POSITIVE_INFINITY
  const candidates = cues.filter((cue) => {
    const text = cue.text.replace(/\s+/g, ' ').trim()
    const len = cue.end - cue.start
    return (
      cue.start >= SKIP_OP_SEC &&
      cue.start <= endCeil &&
      len >= 1.1 &&
      len <= 8 &&
      text.length >= 10
    )
  })
  if (candidates.length === 0) return []

  const picked: SubtitleCue[] = []
  const span = candidates[candidates.length - 1]!.start - candidates[0]!.start
  for (let i = 0; i < MAX_SAMPLES; i += 1) {
    const target =
      candidates.length === 1
        ? candidates[0]!.start
        : candidates[0]!.start + (span * i) / Math.max(1, MAX_SAMPLES - 1)
    let best = candidates[0]!
    let bestDist = Math.abs(best.start - target)
    for (const cue of candidates) {
      const dist = Math.abs(cue.start - target)
      if (dist < bestDist) {
        best = cue
        bestDist = dist
      }
    }
    if (!picked.some((c) => c.start === best.start && c.end === best.end)) {
      picked.push(best)
    }
  }
  return picked.slice(0, MAX_SAMPLES)
}

function findSpeechOnsetSec(pcm: Float32Array, sampleRate: number): number | null {
  const win = Math.max(1, Math.floor(sampleRate * 0.02))
  const hop = win
  const rms: number[] = []
  for (let i = 0; i + win <= pcm.length; i += hop) {
    let sum = 0
    for (let j = 0; j < win; j += 1) {
      const s = pcm[i + j] || 0
      sum += s * s
    }
    rms.push(Math.sqrt(sum / win))
  }
  if (rms.length < 8) return null

  const sorted = [...rms].sort((a, b) => a - b)
  const noise = sorted[Math.floor(sorted.length * 0.25)] || 0.001
  const threshold = Math.max(noise * 4.5, 0.012)

  // Ignore the first ~0.2s (seek / decoder blips).
  const minFrame = Math.floor(0.2 / 0.02)
  for (let i = minFrame; i < rms.length - 3; i += 1) {
    if (rms[i]! > threshold && rms[i + 1]! > threshold && rms[i + 2]! > threshold) {
      return (i * hop) / sampleRate
    }
  }
  return null
}

function capturePcm(video: HTMLVideoElement, durationSec: number): Promise<Float32Array> {
  const { ctx, source } = ensureTap(video)
  const sampleRate = ctx.sampleRate
  const needed = Math.ceil(durationSec * sampleRate)
  const out = new Float32Array(needed)

  return new Promise((resolve, reject) => {
    let writeAt = 0
    let settled = false
    // ScriptProcessor is deprecated but fine for a short desktop experiment capture.
    const processor = ctx.createScriptProcessor(4096, 1, 1)
    const silence = ctx.createGain()
    silence.gain.value = 0

    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      try {
        processor.disconnect()
        silence.disconnect()
      } catch {
        /* ignore */
      }
      try {
        source.disconnect()
      } catch {
        /* ignore */
      }
      // Restore audible playback path.
      try {
        source.connect(ctx.destination)
      } catch {
        /* ignore */
      }
      window.clearTimeout(timer)
      if (err) reject(err)
      else resolve(out.subarray(0, Math.max(1, writeAt)))
    }

    processor.onaudioprocess = (ev) => {
      if (settled) return
      const input = ev.inputBuffer.getChannelData(0)
      const n = Math.min(input.length, needed - writeAt)
      if (n > 0) {
        out.set(input.subarray(0, n), writeAt)
        writeAt += n
      }
      if (writeAt >= needed) finish()
    }

    // Mute speakers during capture without muting the element (muted zeros MediaElementSource).
    try {
      source.disconnect()
    } catch {
      /* ignore */
    }
    source.connect(processor)
    processor.connect(silence)
    silence.connect(ctx.destination)

    const timer = window.setTimeout(() => {
      if (writeAt > sampleRate * 0.5) finish()
      else finish(new Error('Audio capture timed out'))
    }, Math.ceil(durationSec * 1000) + 2500)
  })
}

function waitSeekSettled(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      video.removeEventListener('seeked', done)
      window.clearTimeout(timer)
      resolve()
    }
    const timer = window.setTimeout(done, 2500)
    video.addEventListener('seeked', done)
  })
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return ((sorted[mid - 1] || 0) + (sorted[mid] || 0)) / 2
  }
  return sorted[mid] || 0
}

function consensusOffsets(raw: number[]): number[] {
  if (raw.length <= 2) return raw
  const med = median(raw)
  const tight = raw.filter((v) => Math.abs(v - med) <= 2.5)
  return tight.length >= MIN_SAMPLES ? tight : raw
}

/**
 * Run auto-sync against the current video + cues.
 * Temporarily seeks/mutes; restores playhead when finished.
 */
export async function estimateSubtitleDelay(options: {
  video: HTMLVideoElement
  cues: SubtitleCue[]
  /** Absolute title clock for cues (same basis as subtitle cue times). */
  absoluteTime: () => number
  /** Map absolute title time → video.currentTime for seeking. */
  seekToAbsolute: (absSec: number) => void
  onProgress?: (message: string) => void
}): Promise<AutoSyncResult> {
  const { video, cues, seekToAbsolute, onProgress } = options
  if (!isSubtitleAutoSyncAvailable()) {
    return { ok: false, error: 'Auto sync is desktop-only for now' }
  }
  if (!cues.length) return { ok: false, error: 'No subtitle cues loaded' }

  const duration =
    Number(video.duration) > 0 && Number.isFinite(video.duration)
      ? options.absoluteTime() - video.currentTime + video.duration
      : 0
  // Prefer cue timeline span when HTML duration is relative (remux).
  const cueEnd = cues.reduce((m, c) => Math.max(m, c.end), 0)
  const durationSec = Math.max(duration, cueEnd)

  const samples = pickSampleCues(cues, durationSec)
  if (samples.length < MIN_SAMPLES) {
    return { ok: false, error: 'Need more mid-episode cues to auto-sync' }
  }

  const resumeAt = options.absoluteTime()
  const wasPaused = video.paused

  const offsets: number[] = []

  try {
    onProgress?.('Auto sync… preparing audio')
    const { ctx } = ensureTap(video)
    await ctx.resume()
    if (wasPaused) {
      try {
        await video.play()
      } catch {
        /* continue; capture may still get decoded audio after seek */
      }
    }

    for (let i = 0; i < samples.length; i += 1) {
      const cue = samples[i]!
      onProgress?.(`Auto sync… sample ${i + 1}/${samples.length}`)
      const windowStart = Math.max(0, cue.start - PRE_ROLL_SEC)
      seekToAbsolute(windowStart)
      await waitSeekSettled(video)
      // Small settle so the decoder isn’t silent on the first buffers.
      await new Promise((r) => window.setTimeout(r, 180))

      let pcm: Float32Array
      try {
        pcm = await capturePcm(video, CAPTURE_SEC)
      } catch {
        continue
      }

      const onset = findSpeechOnsetSec(pcm, ensureTap(video).ctx.sampleRate)
      if (onset == null) continue

      const speechAbs = windowStart + onset
      // Player: positive delay = show cues later. If speech is after the cue
      // start, subs are early ("faster") → positive delay.
      const delay = speechAbs - cue.start
      if (!Number.isFinite(delay) || Math.abs(delay) > MAX_ABS_DELAY + 2) continue
      offsets.push(Math.max(-MAX_ABS_DELAY, Math.min(MAX_ABS_DELAY, delay)))
    }
  } finally {
    seekToAbsolute(resumeAt)
    await waitSeekSettled(video)
    if (wasPaused) {
      try {
        video.pause()
      } catch {
        /* ignore */
      }
    } else {
      try {
        await video.play()
      } catch {
        /* ignore */
      }
    }
  }

  const agreed = consensusOffsets(offsets)
  if (agreed.length < MIN_SAMPLES) {
    return {
      ok: false,
      error:
        offsets.length === 0
          ? 'Couldn’t hear clear speech near the cues'
          : 'Auto sync samples disagreed — try manual Subs − / +',
    }
  }

  const delaySec = Math.round(median(agreed) * 10) / 10
  if (Math.abs(delaySec) < 0.15) {
    return { ok: true, delaySec: 0, samples: agreed.length, method: 'energy-onset' }
  }
  return {
    ok: true,
    delaySec: Math.max(-MAX_ABS_DELAY, Math.min(MAX_ABS_DELAY, delaySec)),
    samples: agreed.length,
    method: 'energy-onset',
  }
}
