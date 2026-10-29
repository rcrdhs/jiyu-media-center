/**
 * Jiyu Roku HLS bridge
 *
 * Sports embeds (JW + P2P) hide real media in MSE; public m3u8 is often a decoy.
 * Architecture:
 *   1) Quick sniff for a *real* HLS playlist → header-aware proxy (no remux).
 *   2) Else capture MSE fMP4 via loopback binary ingest, remux to MPEG-TS in
 *      memory (ffmpeg stdin/stdout pipes, one job at a time), serve classic HLS.
 *
 *   POST /api/resolve  { "iframe": "…" }
 *   GET  /api/mse?sid=&p=master|ts&i=
 *   GET  /api/hls?sid=&url=&referer=   (real-HLS proxy mode)
 *   GET  /api/movy?u=<api.wecollege.net/…>  Samsung Movy seed/sources (Referer)
 *   POST /internal/ingest?sid=         (127.0.0.1 only, raw fMP4 bytes)
 *   GET  /health
 */
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const puppeteer = require('puppeteer-core')
const ffmpegPath = require('ffmpeg-static')

const PORT = Number(process.env.ROKU_HLS_PORT || 8791)
const TOKEN = String(process.env.ROKU_HLS_TOKEN || '').trim()
const RESOLVE_MS = Number(process.env.ROKU_HLS_RESOLVE_MS || 35_000)
const CACHE_MS = Number(process.env.ROKU_HLS_CACHE_MS || 180_000)
const SNIFF_MS = Number(process.env.ROKU_HLS_SNIFF_MS || 8_000)
/** Live playlist depth — long windows make Roku rebuffer back to an old edge. */
const SEG_WINDOW = 8
const RAW_SEG_WINDOW = 48
const INGEST_HOST = '127.0.0.1'

/** @type {import('puppeteer-core').Browser | null} */
let browser = null
const resolveCache = new Map()

/**
 * @typedef {{
 *   mode: 'mse' | 'hls',
 *   referer: string,
 *   mediaUrl: string,
 *   page: import('puppeteer-core').Page | null,
 *   videoInit: Buffer | null,
 *   audioInit: Buffer | null,
 *   videoTimescale: number,
 *   audioTimescale: number,
 *   videoSegs: { seq: number, buf: Buffer, dur: number, ptsSec?: number|null, at: number }[],
 *   audioSegs: { seq: number, buf: Buffer, dur: number, ptsSec?: number|null, at: number }[],
 *   tsSegs: { seq: number, vSeq: number, buf: Buffer, dur: number }[],
 *   playlist: string,
 *   variants: Record<string, string>,
 *   segments: Record<string, Buffer>,
 *   nextSeq: number,
 *   nextMediaSeq: number,
 *   drainTimer: NodeJS.Timeout | null,
 *   lastDrainAt: number,
 *   drainCount: number,
 *   ingestCount: number,
 *   at: number,
 * }} Session
 */
/** @type {Map<string, Session>} */
const sessions = new Map()

/** @type {{ session: Session, video: {seq:number,buf:Buffer,dur:number}, audio: Buffer | null }[]} */
const remuxQueue = []
let remuxBusy = false

function newSessionId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function isLoopback(req) {
  const a = req.socket?.remoteAddress || ''
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
}

async function closeSession(id, s) {
  if (s?.drainTimer) clearInterval(s.drainTimer)
  sessions.delete(id)
  if (s?.page) await s.page.close().catch(() => {})
}

async function pruneSessions() {
  const now = Date.now()
  for (const [id, s] of sessions) {
    if (now - s.at > CACHE_MS) await closeSession(id, s)
  }
}

async function closeOtherSessions(keepSid = null) {
  for (const [id, s] of [...sessions.entries()]) {
    if (keepSid && id === keepSid) continue
    await closeSession(id, s)
  }
  for (const [url, cached] of [...resolveCache.entries()]) {
    if (keepSid && cached.sid === keepSid) continue
    resolveCache.delete(url)
  }
}

function findChrome() {
  const fromEnv = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv
  const candidates = [
    path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ]
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p
  }
  return null
}

async function getBrowser() {
  if (browser && browser.connected) return browser
  const exe = findChrome()
  if (!exe) throw new Error('Chrome/Edge not found — set PUPPETEER_EXECUTABLE_PATH')
  browser = await puppeteer.launch({
    executablePath: exe,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--autoplay-policy=no-user-gesture-required',
      // Do NOT --mute-audio: Chromium throttles muted headless tabs and stops media.
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling',
      '--disable-blink-features=AutomationControlled',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  })
  browser.on('disconnected', () => {
    browser = null
  })
  return browser
}

function authOk(req) {
  if (!TOKEN) return true
  const h = String(req.headers['x-jiyu-token'] || '')
  const q = new URL(req.url || '/', 'http://x').searchParams.get('token') || ''
  return h === TOKEN || q === TOKEN
}

function publicBase(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${PORT}`
  const proto = req.headers['x-forwarded-proto'] || 'http'
  return `${proto}://${host}`
}

function originOf(url) {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

function boxType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return ''
  return buf.slice(4, 8).toString('ascii')
}

function isVideoMime(mime) {
  return /video/i.test(mime || '')
}

function isAudioMime(mime) {
  return /audio/i.test(mime || '')
}

/** Walk ISO-BMFF boxes (handles simple containers). */
function findBox(buf, type, start = 0, end = buf.length) {
  let i = start
  while (i + 8 <= end) {
    let size = buf.readUInt32BE(i)
    const typ = buf.slice(i + 4, i + 8).toString('ascii')
    if (size === 0) size = end - i
    if (size === 1) {
      if (i + 16 > end) break
      size = Number(buf.readBigUInt64BE(i + 8))
    }
    if (size < 8 || i + size > end) break
    if (typ === type) return { offset: i, size }
    if (
      typ === 'moov' ||
      typ === 'trak' ||
      typ === 'mdia' ||
      typ === 'minf' ||
      typ === 'stbl' ||
      typ === 'moof' ||
      typ === 'traf'
    ) {
      const hit = findBox(buf, type, i + 8, i + size)
      if (hit) return hit
    }
    i += size
  }
  return null
}

function parseTimescale(initBuf) {
  if (!Buffer.isBuffer(initBuf)) return 0
  const mdhd = findBox(initBuf, 'mdhd')
  if (!mdhd) return 0
  const ver = initBuf[mdhd.offset + 8]
  try {
    if (ver === 1) return initBuf.readUInt32BE(mdhd.offset + 28)
    return initBuf.readUInt32BE(mdhd.offset + 20)
  } catch {
    return 0
  }
}

/** Decode time in seconds from moof/traf/tfdt (+ optional trun duration). */
function parseFragTiming(moofBuf, timescale) {
  const out = { ptsSec: null, durSec: null }
  if (!Buffer.isBuffer(moofBuf) || !timescale) return out
  const tfdt = findBox(moofBuf, 'tfdt')
  if (tfdt) {
    const ver = moofBuf[tfdt.offset + 8]
    try {
      let base
      if (ver === 1) {
        const hi = moofBuf.readUInt32BE(tfdt.offset + 12)
        const lo = moofBuf.readUInt32BE(tfdt.offset + 16)
        base = hi * 4294967296 + lo
      } else {
        base = moofBuf.readUInt32BE(tfdt.offset + 12)
      }
      out.ptsSec = base / timescale
    } catch {
      /* ignore */
    }
  }
  const trun = findBox(moofBuf, 'trun')
  if (trun) {
    try {
      const ver = moofBuf[trun.offset + 8]
      const flags =
        (moofBuf[trun.offset + 9] << 16) |
        (moofBuf[trun.offset + 10] << 8) |
        moofBuf[trun.offset + 11]
      let o = trun.offset + 12
      const sampleCount = moofBuf.readUInt32BE(o)
      o += 4
      if (flags & 0x000001) o += 4 // data_offset
      if (flags & 0x000004) o += 4 // first_sample_flags
      let total = 0
      const hasDur = flags & 0x000100
      const hasSize = flags & 0x000200
      const hasFlags = flags & 0x000400
      const hasCto = flags & 0x000800
      for (let s = 0; s < sampleCount; s++) {
        if (hasDur) {
          total += moofBuf.readUInt32BE(o)
          o += 4
        }
        if (hasSize) o += 4
        if (hasFlags) o += 4
        if (hasCto) o += ver === 0 ? 4 : 4
      }
      if (hasDur && total > 0) out.durSec = total / timescale
    } catch {
      /* ignore */
    }
  }
  return out
}

/**
 * Cover a video fragment with ALL overlapping audio frags (audio is often 2s,
 * video 6s). Muxing a single short audio chunk onto long video → slow picture
 * + permanent A/V drift on Roku (audio is the master clock).
 */
function collectAudioForVideo(session, videoEntry) {
  if (!session.audioSegs.length) return null
  const vDur = videoEntry.dur > 0.4 && videoEntry.dur < 12 ? videoEntry.dur : 2.0
  const vHasPts = videoEntry.ptsSec != null && Number.isFinite(videoEntry.ptsSec)
  let picked = []

  if (vHasPts) {
    const v0 = videoEntry.ptsSec
    const v1 = v0 + vDur
    picked = session.audioSegs
      .filter((a) => {
        if (a.ptsSec == null || !Number.isFinite(a.ptsSec)) return false
        const aDur = a.dur > 0.2 && a.dur < 12 ? a.dur : 2.0
        const a1 = a.ptsSec + aDur
        return a1 >= v0 - 0.15 && a.ptsSec <= v1 + 0.15
      })
      .sort((a, b) => a.ptsSec - b.ptsSec)
  }

  if (!picked.length) {
    const t0 = videoEntry.at - 400
    const t1 = videoEntry.at + vDur * 1000 + 800
    picked = session.audioSegs
      .filter((a) => a.at >= t0 && a.at <= t1)
      .sort((a, b) => a.at - b.at)
  }

  if (!picked.length) {
    // Nearest single frag — better than silence for Roku's audio clock.
    let best = null
    let bestDiff = Infinity
    for (const a of session.audioSegs) {
      const d =
        vHasPts && a.ptsSec != null
          ? Math.abs(a.ptsSec - videoEntry.ptsSec)
          : Math.abs(a.at - videoEntry.at) / 1000
      if (d < bestDiff) {
        bestDiff = d
        best = a
      }
    }
    if (best) picked = [best]
  }

  if (!picked.length) return null
  return Buffer.concat(picked.map((a) => a.buf))
}

function playlistUris(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
}

function isDecoyUri(u) {
  const s = String(u || '').toLowerCase()
  if (!s) return true
  if (s.includes('tiktokcdn') || s.includes('tplv-tiktokx') || s.includes('~tplv-')) return true
  if (/\.(image|webp|jpe?g|png|gif|bmp)(\?|$)/i.test(s)) return true
  return false
}

function isDecoyPlaylist(text) {
  const uris = playlistUris(text)
  if (!uris.length) return false
  const decoys = uris.filter(isDecoyUri).length
  return decoys >= Math.max(1, Math.ceil(uris.length * 0.5))
}

function isRealMediaPlaylist(text) {
  if (!text?.startsWith('#EXTM3U')) return false
  if (!/#EXTINF/i.test(text)) return false
  if (isDecoyPlaylist(text)) return false
  const uris = playlistUris(text)
  // Must have real media segments — masters that only point at decoy variants fail here.
  return uris.some((u) => /\.(ts|m4s)(\?|$)/i.test(u) && !isDecoyUri(u))
}

function isMasterPlaylist(text) {
  return text?.startsWith('#EXTM3U') && /#EXT-X-STREAM-INF/i.test(text) && !/#EXTINF/i.test(text)
}

/* ─── A/C: ffmpeg remux via temp files (Windows has no pipe:3), single-flight queue ─── */

const REMUX_TMP = path.join(os.tmpdir(), 'roku-hls-remux')

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
      reject(new Error('ffmpeg-static missing'))
      return
    }
    const ff = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = []
    let err = ''
    ff.stdout.on('data', (c) => chunks.push(c))
    ff.stderr.on('data', (d) => {
      err += String(d)
    })
    ff.on('error', reject)
    ff.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks))
      else reject(new Error(err.slice(-500) || `ffmpeg exit ${code}`))
    })
  })
}

function unlinkQuiet(p) {
  try {
    fs.unlinkSync(p)
  } catch {
    /* ignore */
  }
}

/**
 * Remux fMP4 init+frag → MPEG-TS.
 * Windows cannot open ffmpeg pipe:3, so A/V inputs are temp files.
 * -copyts keeps fragment PTS continuous so Roku does not reset/speed-run each seg.
 */
async function remuxToTs(videoInit, videoSeg, audioInit, audioSeg) {
  if (!Buffer.isBuffer(videoInit) || !Buffer.isBuffer(videoSeg)) {
    throw new Error('missing video init/seg')
  }
  fs.mkdirSync(REMUX_TMP, { recursive: true })
  const id = randomBytes(6).toString('hex')
  const vPath = path.join(REMUX_TMP, `${id}-v.mp4`)
  const aPath = path.join(REMUX_TMP, `${id}-a.mp4`)
  fs.writeFileSync(vPath, Buffer.concat([videoInit, videoSeg]))

  const common = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-copyts',
    '-muxdelay',
    '0',
    '-muxpreload',
    '0',
    '-c',
    'copy',
    '-bsf:v',
    'h264_mp4toannexb',
    '-mpegts_copyts',
    '1',
    '-f',
    'mpegts',
    'pipe:1',
  ]

  try {
    const tryAv = Buffer.isBuffer(audioInit) && Buffer.isBuffer(audioSeg) && audioSeg.length > 32
    if (tryAv) {
      fs.writeFileSync(aPath, Buffer.concat([audioInit, audioSeg]))
      try {
        const out = await runFfmpeg([
          '-i',
          vPath,
          '-i',
          aPath,
          '-map',
          '0:v:0',
          '-map',
          '1:a:0?',
          ...common,
        ])
        if (out?.[0] === 0x47) return out
      } catch (err) {
        console.log(
          '[roku-hls] AV remux fail, video-only',
          err instanceof Error ? err.message.slice(0, 120) : err,
        )
      }
    }
    // Must await — finally deletes the temp inputs.
    return await runFfmpeg(['-i', vPath, '-map', '0:v:0', ...common])
  } finally {
    unlinkQuiet(vPath)
    unlinkQuiet(aPath)
  }
}

function remuxQueuedOrDone(session, vSeq) {
  if (session.tsSegs.some((t) => t.vSeq === vSeq)) return true
  return remuxQueue.some((j) => j.session === session && j.video.seq === vSeq)
}

function enqueueRemux(session, videoEntry) {
  if (!session?.videoInit || !videoEntry?.buf) return
  // Drain timer used to re-queue the same vSeq every 400ms → queue explosion.
  if (remuxQueuedOrDone(session, videoEntry.seq)) return
  // Hold until audio init arrives so we do not permanently bake video-only TS.
  if (!session.audioInit) {
    if (Date.now() - videoEntry.at < 12_000) return
  } else if (!session.audioSegs.length && Date.now() - videoEntry.at < 4_000) {
    return
  }
  remuxQueue.push({
    session,
    video: videoEntry,
    audio: null, // collected fresh at remux time
  })
  // Keep only the live edge — backlog = laggy/desynced Roku play.
  while (remuxQueue.length > 4) remuxQueue.shift()
  pumpRemuxQueue()
}

function pumpRemuxQueue() {
  if (remuxBusy) return
  const job = remuxQueue.shift()
  if (!job) return
  // Drop jobs for closed sessions.
  if (![...sessions.values()].includes(job.session)) {
    pumpRemuxQueue()
    return
  }
  if (job.session.tsSegs.some((t) => t.vSeq === job.video.seq)) {
    pumpRemuxQueue()
    return
  }
  remuxBusy = true
  // Cover full video duration with every overlapping audio frag.
  const audioBuf = collectAudioForVideo(job.session, job.video) || job.audio
  remuxToTs(job.session.videoInit, job.video.buf, job.session.audioInit, audioBuf)
    .then((ts) => {
      if (!ts || ts[0] !== 0x47) return
      const s = job.session
      if (typeof s.nextMediaSeq !== 'number') s.nextMediaSeq = 0
      // Contiguous media sequence (ingest seq skips audio numbers and confuses Roku).
      const mediaSeq = s.nextMediaSeq++
      const row = {
        seq: mediaSeq,
        vSeq: job.video.seq,
        buf: ts,
        dur: job.video.dur,
      }
      s.tsSegs.push(row)
      while (s.tsSegs.length > SEG_WINDOW) s.tsSegs.shift()
      s.at = Date.now()
    })
    .catch((err) => {
      console.log(
        '[roku-hls] remux fail',
        err instanceof Error ? err.message.slice(0, 160) : err,
      )
    })
    .finally(() => {
      remuxBusy = false
      pumpRemuxQueue()
    })
}

function remuxPending(session) {
  if (!session.videoInit) return
  const pending = session.videoSegs.filter((v) => !remuxQueuedOrDone(session, v.seq))
  // Prefer the live edge — oldest unfinished segs are already stale for Roku.
  const work = pending.length > 3 ? pending.slice(-3) : pending
  for (const v of work) enqueueRemux(session, v)
}

/* ─── MSE ingest ─── */

function ingestMseBuffer(session, mime, buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return
  const kind = boxType(buf)
  const audio = isAudioMime(mime)
  const video = isVideoMime(mime)
  const now = Date.now()

  if (kind === 'ftyp' || kind === 'styp') {
    if (audio || (!video && session.videoInit && !session.audioInit)) {
      if (!session.audioInit || buf.length >= session.audioInit.length) {
        session.audioInit = buf
        session.audioTimescale = parseTimescale(buf) || session.audioTimescale || 0
      }
    } else if (!session.videoInit || buf.length >= session.videoInit.length) {
      session.videoInit = buf
      session.videoTimescale = parseTimescale(buf) || session.videoTimescale || 0
    }
    session.at = now
    return
  }

  if (kind !== 'moof' && kind !== 'mdat' && buf.length < 10_000) return

  const isAud =
    audio || (!video && buf.length < 200_000 && session.videoSegs.length > 0 && session.audioInit)
  const timescale = isAud ? session.audioTimescale : session.videoTimescale
  const timing = parseFragTiming(buf, timescale || 0)

  // Prefer real media duration. Never invent 6s — overstating empties Roku's buffer.
  let dur = timing.durSec
  if (!(dur > 0.4 && dur < 12)) dur = null

  const seq = session.nextSeq++
  const entry = {
    seq,
    buf,
    dur: dur || 2.0, // safe provisional; refined from PTS deltas below
    ptsSec: timing.ptsSec,
    at: now,
  }

  if (isAud) {
    session.audioSegs.push(entry)
    while (session.audioSegs.length > RAW_SEG_WINDOW) session.audioSegs.shift()
  } else {
    // Refine previous video duration from PTS gap (most accurate for live).
    const prev = session.videoSegs[session.videoSegs.length - 1]
    if (
      prev &&
      prev.ptsSec != null &&
      entry.ptsSec != null &&
      entry.ptsSec > prev.ptsSec
    ) {
      const gap = entry.ptsSec - prev.ptsSec
      if (gap > 0.4 && gap < 12) prev.dur = gap
    } else if (prev && !timing.durSec) {
      // Wall-clock gap clamped — still better than a fake 6.0
      const gap = (entry.at - prev.at) / 1000
      if (gap > 0.5 && gap < 10) prev.dur = gap
    }
    if (!dur && prev?.dur) entry.dur = prev.dur

    session.videoSegs.push(entry)
    const remuxed = new Set(session.tsSegs.map((t) => t.vSeq))
    while (session.videoSegs.length > RAW_SEG_WINDOW) {
      if (remuxed.has(session.videoSegs[0].seq)) session.videoSegs.shift()
      else break
    }
    if (session.videoInit) enqueueRemux(session, entry)
  }
  session.ingestCount++
  session.lastDrainAt = now
  session.at = now
}

function mseHookScript(sid, ingestPort) {
  return `(() => {
  if (window.__jiyuHooked) return;
  window.__jiyuHooked = true;
  window.__jiyuSegs = [];
  window.__jiyuMeta = [];
  const ingestUrl = 'http://127.0.0.1:${ingestPort}/internal/ingest?sid=${sid}';
  try {
    Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
  } catch (_) {}
  // Keep the tab "audible" so Chromium does not throttle media after ~60–120s.
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx && !window.__jiyuAudioKeepalive) {
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.00001;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      window.__jiyuAudioKeepalive = ctx;
      document.addEventListener('click', () => ctx.resume().catch(() => {}), { once: true });
      ctx.resume().catch(() => {});
    }
  } catch (_) {}
  const toU8 = (data) => {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return new Uint8Array(0);
  };
  const postRaw = (mime, u8) => {
    try {
      fetch(ingestUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Jiyu-Mime': String(mime || ''),
        },
        body: u8,
        mode: 'cors',
        keepalive: true,
      }).catch(() => {
        // Fallback queue for Node drain if loopback fetch is blocked.
        if (window.__jiyuSegs.length > 40) {
          window.__jiyuSegs.shift();
          window.__jiyuMeta.shift();
        }
        window.__jiyuSegs.push(u8.slice(0));
        window.__jiyuMeta.push({ mime: String(mime || ''), len: u8.length, t: Date.now() });
      });
    } catch (_) {
      window.__jiyuSegs.push(u8.slice(0));
      window.__jiyuMeta.push({ mime: String(mime || ''), len: u8.length, t: Date.now() });
    }
  };
  const patchSB = () => {
    const SB = window.SourceBuffer && window.SourceBuffer.prototype;
    if (!SB || SB.__jiyu) return;
    SB.__jiyu = true;
    const orig = SB.appendBuffer;
    SB.appendBuffer = function (data) {
      try {
        const u8 = toU8(data);
        if (u8.length > 0) postRaw(this.__jiyuMime || this.mimeType || '', u8);
      } catch (_) {}
      return orig.apply(this, arguments);
    };
  };
  const patchMS = () => {
    const MS = window.MediaSource && window.MediaSource.prototype;
    if (!MS || MS.__jiyu) return;
    MS.__jiyu = true;
    const orig = MS.addSourceBuffer;
    MS.addSourceBuffer = function (mime) {
      const sb = orig.call(this, mime);
      try { sb.__jiyuMime = String(mime || ''); } catch (_) {}
      return sb;
    };
  };
  patchMS();
  patchSB();
  setInterval(() => { patchMS(); patchSB(); }, 400);
})();`
}

/** Backup path if page fetch to loopback fails — still avoid huge single transfers. */
async function drainMseFallback(session) {
  if (!session.page || session.page.isClosed()) return
  try {
    const batch = await session.page.evaluate(() => {
      const segs = window.__jiyuSegs || []
      const meta = window.__jiyuMeta || []
      if (!segs.length) return []
      const n = Math.min(segs.length, 2)
      const out = []
      for (let i = 0; i < n; i++) {
        const u8 = segs.shift()
        const m = meta.shift() || {}
        let bin = ''
        const chunk = 0x8000
        for (let j = 0; j < u8.length; j += chunk) {
          bin += String.fromCharCode.apply(null, u8.subarray(j, j + chunk))
        }
        out.push({ mime: m.mime || '', b64: btoa(bin) })
      }
      return out
    })
    for (const item of batch || []) {
      ingestMseBuffer(session, item.mime, Buffer.from(item.b64, 'base64'))
      session.drainCount++
    }
  } catch {
    /* ignore */
  }
}

async function nudgeSitePlayer(page, { clickUi = false } = {}) {
  await page.evaluate(async (wantClick) => {
    const kick = () => {
      document.querySelectorAll('video').forEach((v) => {
        try {
          // Volume ~0 but not muted — muted tabs get throttled; seeking live P2P kills peers.
          v.muted = false
          v.volume = 0.001
          if (v.paused) v.play().catch(() => {})
        } catch (_) {}
      })
      try {
        if (typeof jwplayer === 'function') {
          const p = jwplayer()
          try {
            p.setVolume(1)
            p.setMute(false)
          } catch (_) {}
          if (p.getState && p.getState() === 'paused') p.play()
          else if (!p.getState) p.play()
        }
      } catch (_) {}
      try {
        if (window.__jiyuAudioKeepalive?.resume) window.__jiyuAudioKeepalive.resume()
      } catch (_) {}
      if (!wantClick) return
      for (const el of document.querySelectorAll('button, div, span, a')) {
        const t = (el.textContent || '').trim()
        if (!/unmute|tap to unmute|click to unmute/i.test(t) || t.length > 48) continue
        try {
          el.click()
        } catch (_) {}
      }
    }
    kick()
    if (wantClick) {
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 400))
        kick()
        if ((window.__jiyuSegs || []).length >= 2) break
      }
    }
  }, clickUi)
}

async function keepPageAlive(page) {
  try {
    const client = await page.createCDPSession()
    await client.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
    await client.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {})
  } catch {
    /* ignore */
  }
}

function buildTsPlaylist(base, sid) {
  const session = sessions.get(sid)
  if (!session) return null
  const q = `sid=${encodeURIComponent(sid)}${TOKEN ? `&token=${encodeURIComponent(TOKEN)}` : ''}`
  const segs = [...session.tsSegs].sort((a, b) => a.seq - b.seq)
  if (!segs.length) {
    return '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n'
  }
  const targetDur = Math.max(2, Math.ceil(Math.max(...segs.map((s) => s.dur || 2))))
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    `#EXT-X-TARGETDURATION:${targetDur}`,
    `#EXT-X-MEDIA-SEQUENCE:${segs[0].seq}`,
  ]
  for (const s of segs) {
    lines.push(`#EXTINF:${Number(s.dur || 2).toFixed(3)},`)
    lines.push(`${base}/api/mse?${q}&p=ts&i=${s.seq}`)
  }
  lines.push('')
  return lines.join('\n')
}

function rewriteM3u8(body, baseUrl, proxyBase, sid, referer) {
  const qSid = sid ? `sid=${encodeURIComponent(sid)}&` : ''
  const qRef = `referer=${encodeURIComponent(referer)}`
  const tokenQ = TOKEN ? `token=${encodeURIComponent(TOKEN)}&` : ''
  const lines = body.split(/\r?\n/)
  const out = []
  for (const line of lines) {
    if (!line || line.startsWith('#')) {
      out.push(
        line.replace(/URI="([^"]+)"/gi, (_, u) => {
          const abs = new URL(u, baseUrl).href
          return `URI="${proxyBase}?${tokenQ}${qSid}url=${encodeURIComponent(abs)}&${qRef}"`
        }),
      )
      continue
    }
    try {
      const abs = new URL(line.trim(), baseUrl).href
      out.push(`${proxyBase}?${tokenQ}${qSid}url=${encodeURIComponent(abs)}&${qRef}`)
    } catch {
      out.push(line)
    }
  }
  return out.join('\n')
}

/* ─── D: quick real-HLS sniff ─── */

async function pageFetchText(page, targetUrl) {
  try {
    return await page.evaluate(async (u) => {
      const r = await fetch(u, { credentials: 'include' })
      const t = await r.text()
      return { ok: r.ok, t }
    }, targetUrl)
  } catch {
    return null
  }
}

async function sniffRealHls(iframeUrl) {
  const b = await getBrowser()
  const page = await b.newPage()
  /** @type {{ url: string, playlist: string, kind: 'media' | 'master' }[]} */
  const hits = []
  const onResponse = async (res) => {
    try {
      const u = res.url()
      const ct = String(res.headers()['content-type'] || '')
      if (!/\.m3u8(\?|$)/i.test(u) && !/mpegurl|m3u8/i.test(ct)) return
      const text = await res.text()
      if (isRealMediaPlaylist(text)) hits.push({ url: u, playlist: text, kind: 'media' })
      else if (isMasterPlaylist(text) && !isDecoyPlaylist(text))
        hits.push({ url: u, playlist: text, kind: 'master' })
    } catch {
      /* ignore */
    }
  }
  page.on('response', onResponse)
  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    )
    await page.goto(iframeUrl, {
      waitUntil: 'domcontentloaded',
      timeout: SNIFF_MS,
      referer: '',
    })
    const until = Date.now() + SNIFF_MS
    while (Date.now() < until && !hits.some((h) => h.kind === 'media')) {
      await new Promise((r) => setTimeout(r, 250))
    }

    let best = hits.find((h) => h.kind === 'media')
    if (!best) {
      const master = hits.find((h) => h.kind === 'master')
      if (master) {
        const variant = playlistUris(master.playlist).find((u) => /\.m3u8(\?|$)/i.test(u))
        if (variant) {
          const abs = new URL(variant, master.url).href
          const pulled = await pageFetchText(page, abs)
          if (pulled?.ok && isRealMediaPlaylist(pulled.t)) {
            best = { url: abs, playlist: pulled.t, kind: 'media' }
          } else {
            console.log('[roku-hls] sniff master→decoy variant, use MSE')
          }
        }
      }
    }

    if (!best) {
      await page.close().catch(() => {})
      return null
    }

    const sid = newSessionId()
    /** @type {Session} */
    const session = {
      mode: 'hls',
      referer: iframeUrl,
      mediaUrl: best.url,
      page,
      videoInit: null,
      audioInit: null,
      videoTimescale: 0,
      audioTimescale: 0,
      videoSegs: [],
      audioSegs: [],
      tsSegs: [],
      playlist: best.playlist,
      variants: {},
      segments: {},
      nextSeq: 1,
      nextMediaSeq: 0,
      drainTimer: null,
      lastDrainAt: 0,
      drainCount: 0,
      ingestCount: 0,
      at: Date.now(),
    }
    sessions.set(sid, session)
    console.log('[roku-hls] real HLS sniff OK', best.url.slice(0, 96))
    return { sid, mediaUrl: best.url, referer: iframeUrl, mode: 'hls' }
  } catch {
    await page.close().catch(() => {})
    return null
  } finally {
    page.off('response', onResponse)
  }
}

async function proxyHlsFetch(targetUrl, referer) {
  const ytCdn = /googlevideo\.com|ytimg\.com|youtube\.com/i.test(targetUrl)
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Accept: '*/*',
    Referer: ytCdn ? 'https://www.youtube.com/' : referer || originOf(targetUrl) || 'https://www.youtube.com/',
  }
  try {
    headers.Origin = ytCdn
      ? 'https://www.youtube.com'
      : new URL(referer || targetUrl).origin
  } catch {
    /* ignore */
  }
  const res = await fetch(targetUrl, { headers, redirect: 'follow' })
  const ct = String(res.headers.get('content-type') || '')
  const buf = Buffer.from(await res.arrayBuffer())
  return { ok: res.ok, status: res.status, ct, buf }
}

/* ─── MSE resolve path ─── */

async function resolveViaMse(iframeUrl) {
  const sid = newSessionId()
  const b = await getBrowser()
  const page = await b.newPage()
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  )
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' })

  /** @type {Session} */
  const session = {
    mode: 'mse',
    referer: iframeUrl,
    mediaUrl: iframeUrl,
    page,
    videoInit: null,
    audioInit: null,
    videoTimescale: 0,
    audioTimescale: 0,
    videoSegs: [],
    audioSegs: [],
    tsSegs: [],
    playlist: '',
    variants: {},
    segments: {},
    nextSeq: 1,
    nextMediaSeq: 0,
    drainTimer: null,
    lastDrainAt: 0,
    drainCount: 0,
    ingestCount: 0,
    at: Date.now(),
  }
  sessions.set(sid, session)

  const hook = mseHookScript(sid, PORT)
  await page.evaluateOnNewDocument(hook)

  try {
    await keepPageAlive(page)
    await page.goto(iframeUrl, {
      waitUntil: 'domcontentloaded',
      timeout: RESOLVE_MS,
      referer: '',
    })
    await page.evaluate(hook)
    await keepPageAlive(page)
    await nudgeSitePlayer(page, { clickUi: true })

    const deadline = Date.now() + Math.max(28_000, RESOLVE_MS - 3_000)
    while (Date.now() < deadline) {
      // Always drain the page fallback queue — loopback fetch may only partially work.
      await drainMseFallback(session)
      remuxPending(session)
      if (session.tsSegs.length >= 6) break
      await nudgeSitePlayer(page, { clickUi: false })
      await new Promise((r) => setTimeout(r, 300))
    }

    if (!session.tsSegs.length) {
      console.log('[roku-hls] retry embed load', iframeUrl.slice(0, 80))
      await page.goto(iframeUrl, {
        waitUntil: 'domcontentloaded',
        timeout: RESOLVE_MS,
        referer: '',
      })
      await page.evaluate(hook)
      await nudgeSitePlayer(page, { clickUi: true })
      const retryUntil = Date.now() + 18_000
      while (Date.now() < retryUntil) {
        await drainMseFallback(session)
        remuxPending(session)
        if (session.tsSegs.length >= 4) break
        await nudgeSitePlayer(page, { clickUi: false })
        await new Promise((r) => setTimeout(r, 300))
      }
    }

    // Wait briefly for in-flight pipe remux jobs.
    const remuxWait = Date.now() + 8_000
    while (Date.now() < remuxWait && session.tsSegs.length < 4 && (remuxBusy || remuxQueue.length)) {
      await new Promise((r) => setTimeout(r, 200))
    }
    remuxPending(session)
    await new Promise((r) => setTimeout(r, 500))

    console.log(
      '[roku-hls] mse→ts',
      'ingest',
      session.ingestCount,
      'vInit',
      session.videoInit?.length || 0,
      'ts',
      session.tsSegs.length,
      'queue',
      remuxQueue.length,
    )

    if (!session.tsSegs.length) {
      await closeSession(sid, session)
      return {
        ok: false,
        error:
          'This card never started video on the PC (try another match). Phone/desktop Jiyu may still play it.',
      }
    }

    let tick = 0
    session.drainTimer = setInterval(() => {
      tick++
      drainMseFallback(session)
        .then(() => remuxPending(session))
        .catch(() => {})
      nudgeSitePlayer(session.page, { clickUi: false }).catch(() => {})
      if (tick % 5 === 0) {
        keepPageAlive(session.page).catch(() => {})
        console.log(
          '[roku-hls] live',
          sid.slice(0, 8),
          'ts',
          session.tsSegs.length,
          'ingest',
          session.ingestCount,
          'q',
          remuxQueue.length,
          'ago',
          session.lastDrainAt ? `${Math.round((Date.now() - session.lastDrainAt) / 1000)}s` : 'never',
        )
      }
    }, 400)

    return {
      ok: true,
      sid,
      mediaUrl: iframeUrl,
      referer: iframeUrl,
      mode: 'mse',
    }
  } catch (err) {
    await closeSession(sid, session)
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Resolve failed',
    }
  }
}

function isYouTubeUrl(u) {
  try {
    const h = new URL(u).hostname.replace(/^www\./, '')
    return h === 'youtube.com' || h === 'youtu.be' || h === 'm.youtube.com' || h === 'music.youtube.com'
  } catch {
    return /youtube\.com|youtu\.be/i.test(String(u || ''))
  }
}

function findYtDlp() {
  const fromEnv = process.env.YT_DLP_PATH
  if (fromEnv && fs.existsSync(fromEnv)) return { cmd: fromEnv, prefix: [] }
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python314', 'Scripts', 'yt-dlp.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python313', 'Scripts', 'yt-dlp.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'Scripts', 'yt-dlp.exe'),
    path.join(process.env.PROGRAMFILES || '', 'yt-dlp', 'yt-dlp.exe'),
  ]
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return { cmd: p, prefix: [] }
  }
  return { cmd: process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp', prefix: [] }
}

/** Nationwide / YouTube live → googlevideo HLS master (via yt-dlp). */
async function resolveYouTubeLive(liveUrl) {
  const { cmd, prefix } = findYtDlp()
  const args = [
    ...prefix,
    '-J',
    '--no-warnings',
    '--no-playlist',
    '--skip-download',
    liveUrl,
  ]
  let raw
  try {
    raw = await new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      const chunks = []
      let err = ''
      const t = setTimeout(() => {
        child.kill()
        reject(new Error('yt-dlp timed out'))
      }, 55_000)
      child.stdout.on('data', (c) => chunks.push(c))
      child.stderr.on('data', (d) => {
        err += String(d)
      })
      child.on('error', (e) => {
        clearTimeout(t)
        reject(e)
      })
      child.on('close', (code) => {
        clearTimeout(t)
        if (code === 0) resolve(Buffer.concat(chunks).toString('utf8'))
        else reject(new Error(err.slice(-400) || `yt-dlp exit ${code}`))
      })
    })
  } catch (err) {
    console.log(
      '[roku-hls] yt-dlp fail',
      err instanceof Error ? err.message.slice(0, 160) : err,
    )
    return null
  }

  let info
  try {
    info = JSON.parse(raw)
  } catch {
    return null
  }
  if (!info || info.is_live === false) {
    // Still try if formats look live.
  }
  const formats = Array.isArray(info.formats) ? info.formats : []
  let master =
    formats.map((f) => f?.manifest_url).find((u) => typeof u === 'string' && u.includes('hls_variant')) ||
    formats.map((f) => f?.manifest_url).find((u) => typeof u === 'string' && /m3u8/i.test(u)) ||
    null
  if (!master && typeof info.manifest_url === 'string') master = info.manifest_url
  if (!master || !/^https?:\/\//i.test(master)) {
    console.log('[roku-hls] yt-dlp: no HLS master for', (info.id || liveUrl).toString().slice(0, 40))
    return null
  }

  const upstream = await proxyHlsFetch(master, 'https://www.youtube.com/')
  if (!upstream.ok || !upstream.buf.slice(0, 7).toString('utf8').startsWith('#EXTM3U')) {
    console.log('[roku-hls] yt-dlp master fetch failed')
    return null
  }
  const playlist = upstream.buf.toString('utf8')
  if (isDecoyPlaylist(playlist)) return null

  const sid = newSessionId()
  /** @type {Session} */
  const session = {
    mode: 'hls',
    referer: 'https://www.youtube.com/',
    mediaUrl: master,
    page: null,
    videoInit: null,
    audioInit: null,
    videoTimescale: 0,
    audioTimescale: 0,
    videoSegs: [],
    audioSegs: [],
    tsSegs: [],
    playlist,
    variants: {},
    segments: {},
    nextSeq: 1,
    nextMediaSeq: 0,
    drainTimer: null,
    lastDrainAt: 0,
    drainCount: 0,
    ingestCount: 0,
    at: Date.now(),
  }
  sessions.set(sid, session)
  console.log(
    '[roku-hls] YouTube live HLS',
    info.id || '',
    info.title ? String(info.title).slice(0, 48) : '',
  )
  return {
    sid,
    mediaUrl: master,
    referer: 'https://www.youtube.com/',
    mode: 'hls',
  }
}

async function resolveEmbed(iframeUrl) {
  await pruneSessions()
  const cached = resolveCache.get(iframeUrl)
  if (cached && Date.now() - cached.at < CACHE_MS && sessions.has(cached.sid)) {
    const s = sessions.get(cached.sid)
    const ready =
      (s.mode === 'mse' && s.tsSegs.length >= 1) || (s.mode === 'hls' && s.playlist)
    if (ready) {
      await closeOtherSessions(cached.sid)
      s.at = Date.now()
      return {
        ok: true,
        mediaUrl: cached.mediaUrl,
        referer: cached.referer,
        sid: cached.sid,
        mode: s.mode,
        cached: true,
      }
    }
  }

  await closeOtherSessions(null)

  // Nationwide / YouTube live — real googlevideo HLS (no MSE remux).
  if (isYouTubeUrl(iframeUrl)) {
    const yt = await resolveYouTubeLive(iframeUrl)
    if (yt) {
      resolveCache.set(iframeUrl, {
        mediaUrl: yt.mediaUrl,
        referer: yt.referer,
        sid: yt.sid,
        at: Date.now(),
      })
      return { ok: true, ...yt, cached: false }
    }
    return {
      ok: false,
      error:
        'YouTube live did not yield HLS (is yt-dlp installed? is the channel on-air?).',
    }
  }

  // D: cheap real-HLS path (skips MSE/ffmpeg when CDN is honest).
  const sniffed = await sniffRealHls(iframeUrl)
  if (sniffed) {
    resolveCache.set(iframeUrl, {
      mediaUrl: sniffed.mediaUrl,
      referer: sniffed.referer,
      sid: sniffed.sid,
      at: Date.now(),
    })
    return { ok: true, ...sniffed, cached: false }
  }

  const mse = await resolveViaMse(iframeUrl)
  if (mse.ok) {
    resolveCache.set(iframeUrl, {
      mediaUrl: mse.mediaUrl,
      referer: mse.referer,
      sid: mse.sid,
      at: Date.now(),
    })
  }
  return mse
}

/* ─── HTTP ─── */

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function readJson(req) {
  return readBody(req).then((buf) => JSON.parse(buf.toString('utf8') || '{}'))
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Jiyu-Token, X-Jiyu-Mime, X-Relay-Referer, Accept',
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

const MOVY_API_REFERER = 'https://www.movy.sx/'
const MOVY_DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** Only Movy seed + city sources — seeds are IP-bound, so this must run on the PC, not Cloudflare. */
function isMovyApiTarget(raw) {
  try {
    const u = new URL(String(raw || ''))
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
    if (u.hostname.toLowerCase() !== 'api.wecollege.net') return false
    return /^\/(?:seed\b|[a-z0-9_-]+\/sources\b)/i.test(u.pathname)
  } catch {
    return false
  }
}

async function proxyMovyApi(req, res, target) {
  try {
    const upstream = await fetch(target, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        Accept: '*/*',
        Referer: MOVY_API_REFERER,
        Origin: 'https://www.movy.sx',
        'User-Agent': MOVY_DESKTOP_UA,
      },
    })
    const buf = Buffer.from(await upstream.arrayBuffer())
    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'text/plain; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'X-Jiyu-Movy-Status',
      'Cache-Control': 'no-store',
      'X-Jiyu-Movy-Status': String(upstream.status),
    })
    res.end(buf)
  } catch (err) {
    sendJson(res, 502, {
      ok: false,
      error: err instanceof Error ? err.message : 'Movy proxy failed',
    })
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Jiyu-Token, X-Jiyu-Mime',
      // Chrome Private Network Access: HTTPS embed → http://127.0.0.1 ingest
      'Access-Control-Allow-Private-Network': 'true',
    })
    res.end()
    return
  }

  if (url.pathname === '/health') {
    let ts = 0
    let ingest = 0
    for (const s of sessions.values()) {
      ts += s.tsSegs.length
      ingest += s.ingestCount
    }
    sendJson(res, 200, {
      ok: true,
      service: 'roku-hls',
      port: PORT,
      sessions: sessions.size,
      tsSegs: ts,
      ingest,
      remuxQueue: remuxQueue.length,
      remuxBusy,
      mode: 'mpegts+hls',
      movyProxy: true,
      ffmpeg: Boolean(ffmpegPath && fs.existsSync(String(ffmpegPath))),
    })
    return
  }

  // B: raw binary MSE ingest from the embed page (loopback only).
  if (req.method === 'POST' && url.pathname === '/internal/ingest') {
    if (!isLoopback(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' })
      res.end('loopback only')
      return
    }
    const sid = url.searchParams.get('sid') || ''
    const session = sessions.get(sid)
    if (!session) {
      res.writeHead(404, {
        'Content-Type': 'text/plain',
        'Access-Control-Allow-Origin': '*',
      })
      res.end('unknown sid')
      return
    }
    const mime = String(req.headers['x-jiyu-mime'] || '')
    const buf = await readBody(req)
    ingestMseBuffer(session, mime, buf)
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' })
    res.end()
    return
  }

  if (!authOk(req)) {
    sendJson(res, 401, { ok: false, error: 'Unauthorized' })
    return
  }

  // Samsung (Tizen): Movy seed/sources need Referer + a non-Cloudflare egress IP.
  // Seeds are bound to the IP that minted them — CF Workers always 429 / invalid.
  if (req.method === 'GET' && url.pathname === '/api/movy') {
    const target = String(url.searchParams.get('u') || '').trim()
    if (!isMovyApiTarget(target)) {
      sendJson(res, 403, { ok: false, error: 'Host not allowed' })
      return
    }
    await proxyMovyApi(req, res, target)
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/resolve') {
    try {
      const body = await readJson(req)
      const iframe = String(body.iframe || body.url || '').trim()
      if (!/^https?:\/\//i.test(iframe)) {
        sendJson(res, 400, { ok: false, error: 'Missing iframe URL' })
        return
      }
      console.log('[roku-hls] resolve', iframe.slice(0, 120))
      const result = await resolveEmbed(iframe)
      if (!result.ok) {
        sendJson(res, 502, result)
        return
      }
      const base = publicBase(req)
      const proxiedUrl =
        result.mode === 'hls'
          ? `${base}/api/hls?sid=${encodeURIComponent(result.sid)}` +
            `&url=${encodeURIComponent(result.mediaUrl)}` +
            `&referer=${encodeURIComponent(result.referer)}` +
            (TOKEN ? `&token=${encodeURIComponent(TOKEN)}` : '')
          : `${base}/api/mse?sid=${encodeURIComponent(result.sid)}&p=master` +
            (TOKEN ? `&token=${encodeURIComponent(TOKEN)}` : '')
      sendJson(res, 200, {
        ok: true,
        mediaUrl: result.mediaUrl,
        referer: result.referer,
        sid: result.sid,
        mode: result.mode,
        proxiedUrl,
        cached: Boolean(result.cached),
      })
    } catch (err) {
      sendJson(res, 500, {
        ok: false,
        error: err instanceof Error ? err.message : 'Resolve error',
      })
    }
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/mse') {
    const sid = url.searchParams.get('sid') || ''
    const p = url.searchParams.get('p') || 'master'
    const session = sessions.get(sid)
    if (!session || session.mode !== 'mse') {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Unknown session')
      return
    }
    session.at = Date.now()
    const base = publicBase(req)

    if (p === 'master' || p === 'video' || p === 'media') {
      remuxPending(session)
      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      })
      res.end(buildTsPlaylist(base, sid) || '')
      return
    }

    if (p === 'ts') {
      const i = Number(url.searchParams.get('i') || '')
      const hit = session.tsSegs.find((s) => s.seq === i)
      // Never substitute a "nearest" segment — that made Roku restart from an old point.
      if (!hit) {
        res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
        res.end('TS segment not in window')
        return
      }
      res.writeHead(200, {
        'Content-Type': 'video/mp2t',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      })
      res.end(hit.buf)
      return
    }

    res.writeHead(400, { 'Content-Type': 'text/plain' })
    res.end('Bad p=')
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/hls') {
    const sid = url.searchParams.get('sid') || ''
    const target = url.searchParams.get('url') || ''
    const referer = url.searchParams.get('referer') || ''
    const session = sid ? sessions.get(sid) : null
    if (!/^https?:\/\//i.test(target)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('Missing url')
      return
    }
    try {
      if (session) {
        session.at = Date.now()
        if (target === session.mediaUrl && session.playlist) {
          const rewritten = rewriteM3u8(
            session.playlist,
            target,
            `${publicBase(req)}/api/hls`,
            sid,
            session.referer || referer,
          )
          res.writeHead(200, {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store',
          })
          res.end(rewritten)
          return
        }
        if (session.variants[target]) {
          const rewritten = rewriteM3u8(
            session.variants[target],
            target,
            `${publicBase(req)}/api/hls`,
            sid,
            session.referer || referer,
          )
          res.writeHead(200, {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store',
          })
          res.end(rewritten)
          return
        }
        if (session.segments[target]) {
          res.writeHead(200, {
            'Content-Type': 'video/mp2t',
            'Access-Control-Allow-Origin': '*',
          })
          res.end(session.segments[target])
          return
        }
      }
      const upstream = await proxyHlsFetch(target, referer || session?.referer || '')
      if (!upstream.ok) {
        res.writeHead(upstream.status || 502, { 'Content-Type': 'text/plain' })
        res.end(upstream.buf.slice(0, 200))
        return
      }
      const text = upstream.buf.slice(0, 7).toString('utf8')
      if (text.startsWith('#EXTM3U')) {
        if (isDecoyPlaylist(upstream.buf.toString('utf8'))) {
          res.writeHead(502, { 'Content-Type': 'text/plain' })
          res.end('Decoy playlist')
          return
        }
        if (session) session.variants[target] = upstream.buf.toString('utf8')
        const rewritten = rewriteM3u8(
          upstream.buf.toString('utf8'),
          target,
          `${publicBase(req)}/api/hls`,
          sid,
          referer || session?.referer || originOf(target),
        )
        res.writeHead(200, {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        })
        res.end(rewritten)
        return
      }
      res.writeHead(200, {
        'Content-Type': upstream.ct || 'video/mp2t',
        'Access-Control-Allow-Origin': '*',
      })
      res.end(upstream.buf)
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'text/plain' })
      res.end(err instanceof Error ? err.message : 'Proxy error')
    }
    return
  }

  sendJson(res, 404, { ok: false, error: 'Not found' })
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[roku-hls] listening on http://0.0.0.0:${PORT}`)
  console.log('[roku-hls] resolve → YouTube/yt-dlp HLS, real-HLS sniff, else MSE+ffmpeg')
  console.log('[roku-hls] ffmpeg', ffmpegPath || 'missing')
  console.log('[roku-hls] yt-dlp', findYtDlp().cmd)
  if (TOKEN) console.log('[roku-hls] token auth enabled')
})

process.on('SIGINT', async () => {
  for (const [id, s] of sessions) await closeSession(id, s)
  if (browser) await browser.close().catch(() => {})
  process.exit(0)
})
