/**
 * Bilibili DASH (separate fMP4 video + audio, SegmentBase) → HLS v7 playlists served
 * as blob: URLs, so the existing hls.js engine plays it on desktop and Android with
 * no extra player library (dash.js / shaka would add ~0.8–1 MB to the bundle).
 *
 * Per track: fetch init + `sidx` with one Range request, read the segment index,
 * emit `#EXT-X-MAP` + `#EXT-X-BYTERANGE` segments pointing at the CDN URL. A master
 * playlist ties AVC video to the AAC audio group. Master URL ends with `#jiyu.m3u8`
 * (fragment is ignored for blob resolution) so isHlsUrl() routes it to hls.js.
 */

import { biliFetchBytes } from './biliHttp'
import { biliLog } from './biliLog'
import type { BiliDashSource, BiliDashTrack } from './bilibiliCn'

export type SidxSegment = { offset: number; size: number; duration: number }

/** Parse an ISO-BMFF `sidx` box at `boxOffset` in `bytes` (absolute file offsets). */
export function parseSidx(bytes: Uint8Array, boxOffset: number, fileOffsetOfBytes = 0): SidxSegment[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let p = boxOffset - fileOffsetOfBytes
  // The index range may start with other boxes (rare) — scan forward for 'sidx'.
  for (let guard = 0; guard < 8 && p + 8 <= bytes.length; guard++) {
    const size = view.getUint32(p)
    const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7])
    if (type === 'sidx') break
    if (size < 8) throw new Error('Bad box before sidx')
    p += size
  }
  if (p + 12 > bytes.length) throw new Error('sidx not in range')
  const boxSize = view.getUint32(p)
  const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7])
  if (type !== 'sidx') throw new Error(`Expected sidx, got ${type}`)
  const boxStartAbs = p + fileOffsetOfBytes
  const version = bytes[p + 8]
  let q = p + 12
  q += 4 // reference_ID
  const timescale = view.getUint32(q)
  q += 4
  let firstOffset: number
  if (version === 0) {
    q += 4 // earliest_presentation_time
    firstOffset = view.getUint32(q)
    q += 4
  } else {
    q += 8
    firstOffset = Number(view.getBigUint64(q))
    q += 8
  }
  q += 2 // reserved
  const count = view.getUint16(q)
  q += 2
  if (q + count * 12 > bytes.length) throw new Error('sidx truncated')
  let offset = boxStartAbs + boxSize + firstOffset
  const out: SidxSegment[] = []
  for (let i = 0; i < count; i++) {
    const ref = view.getUint32(q)
    const dur = view.getUint32(q + 4)
    q += 12
    if (ref & 0x80000000) throw new Error('Nested sidx not supported')
    const size = ref & 0x7fffffff
    out.push({ offset, size, duration: timescale ? dur / timescale : 0 })
    offset += size
  }
  return out
}

function escapeAttr(url: string): string {
  return url.replace(/"/g, '%22')
}

export function buildMediaPlaylist(url: string, initLen: number, segments: SidxSegment[]): string {
  const target = Math.max(1, Math.ceil(Math.max(...segments.map((s) => s.duration), 1)))
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-TARGETDURATION:${target}`,
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    `#EXT-X-MAP:URI="${escapeAttr(url)}",BYTERANGE="${initLen}@0"`,
  ]
  for (const s of segments) {
    lines.push(`#EXTINF:${s.duration.toFixed(3)},`, `#EXT-X-BYTERANGE:${s.size}@${s.offset}`, url)
  }
  lines.push('#EXT-X-ENDLIST', '')
  return lines.join('\n')
}

async function indexTrack(
  track: BiliDashTrack,
  referer: string,
): Promise<{ url: string; initLen: number; segments: SidxSegment[]; status: number } | { error: string }> {
  const end = track.index[1]
  const candidates = [track.url, ...track.backups].filter(Boolean)
  let lastErr = ''
  // Two passes: the CDN sometimes 403s a fresh playurl for a moment (seen on PC probes).
  const attempts = [...candidates, ...candidates.map((u) => `retry:${u}`)]
  for (const entry of attempts) {
    const retry = entry.startsWith('retry:')
    const url = retry ? entry.slice(6) : entry
    if (retry && entry === `retry:${candidates[0]}`) await new Promise((res) => setTimeout(res, 1200))
    const r = await biliFetchBytes(url, { referer, range: `bytes=0-${end}`, timeoutMs: 12_000 })
    let host = ''
    try {
      host = new URL(url).host
    } catch {
      /* ignore */
    }
    if (!r.ok || !r.bytes) {
      lastErr = r.error || `HTTP ${r.status}`
      biliLog('dash.index.fail', { host, status: r.status, error: lastErr, retry })
      continue
    }
    try {
      const segments = parseSidx(r.bytes, track.index[0], 0)
      if (segments.length === 0) throw new Error('empty sidx')
      biliLog('dash.index', { host, status: r.status, segments: segments.length, codecs: track.codecs })
      return { url, initLen: track.init[1] - track.init[0] + 1, segments, status: r.status }
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err)
      biliLog('dash.sidx.fail', { host, error: lastErr, bytes: r.bytes.length })
    }
  }
  return { error: lastErr || 'No CDN URL' }
}

let activeBlobs: string[] = []

function revokeActive(): void {
  for (const u of activeBlobs) {
    try {
      URL.revokeObjectURL(u)
    } catch {
      /* ignore */
    }
  }
  activeBlobs = []
}

function blobUrl(text: string): string {
  const u = URL.createObjectURL(new Blob([text], { type: 'application/vnd.apple.mpegurl' }))
  activeBlobs.push(u)
  return u
}

export type DashHlsBuild = {
  ok: true
  masterUrl: string
  /** Playlist text (debug / probes). */
  master: string
  videoPlaylist: string
  audioPlaylist: string
  videoUrl: string
  height: number
  durationSec: number
}

/** Build the blob HLS for a Bilibili DASH pair. Revokes the previous build's blobs. */
export async function buildBiliDashHls(source: BiliDashSource): Promise<DashHlsBuild | { ok: false; error: string }> {
  const [v, a] = await Promise.all([indexTrack(source.video, source.referer), indexTrack(source.audio, source.referer)])
  if ('error' in v) return { ok: false, error: `Video index: ${v.error}` }
  if ('error' in a) return { ok: false, error: `Audio index: ${a.error}` }
  const videoPlaylist = buildMediaPlaylist(v.url, v.initLen, v.segments)
  const audioPlaylist = buildMediaPlaylist(a.url, a.initLen, a.segments)
  revokeActive()
  const videoBlob = blobUrl(videoPlaylist)
  const audioBlob = blobUrl(audioPlaylist)
  const bw = Math.max(1, (source.video.bandwidth || 0) + (source.audio.bandwidth || 0))
  const res = source.video.width && source.video.height ? `,RESOLUTION=${source.video.width}x${source.video.height}` : ''
  const master = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Chinese",LANGUAGE="zh",DEFAULT=YES,AUTOSELECT=YES,URI="${audioBlob}"`,
    `#EXT-X-STREAM-INF:BANDWIDTH=${bw},CODECS="${source.video.codecs},${source.audio.codecs}"${res},AUDIO="aud"`,
    videoBlob,
    '',
  ].join('\n')
  const masterUrl = `${blobUrl(master)}#jiyu.m3u8`
  const durationSec = v.segments.reduce((s, x) => s + x.duration, 0)
  biliLog('dash.hls', {
    height: source.video.height, videoSegs: v.segments.length, audioSegs: a.segments.length,
    durationSec: Math.round(durationSec), quality: source.quality,
  })
  return {
    ok: true,
    masterUrl,
    master,
    videoPlaylist,
    audioPlaylist,
    videoUrl: v.url,
    height: Number(source.video.height) || 0,
    durationSec,
  }
}
