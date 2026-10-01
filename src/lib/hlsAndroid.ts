/**
 * Android Capacitor + hls.js helpers.
 *
 * 1) CapacitorHttp must not globally patch XHR (breaks relative playlist URLs).
 * 2) WebView blocks xhr.setRequestHeader('Referer') — Movy/IPTV CDNs need it.
 *    Use a CapacitorHttp-backed loader so native OkHttp can send Referer / UA.
 */

import Hls, {
  type HlsConfig,
  type LoaderCallbacks,
  type LoaderConfiguration,
  type LoaderContext,
  type LoaderResponse,
  type LoaderStats,
} from 'hls.js'
import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { looksLikeAtlanticWarpPage } from './atlanticHls'

export function isAndroidCapacitor(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
  } catch {
    return false
  }
}

export type AndroidHlsPlaybackHeaders = {
  referrer?: string
  userAgent?: string
  origin?: string
}

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

function buildNativeHeaders(extra?: AndroidHlsPlaybackHeaders): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: '*/*',
    'User-Agent': (extra?.userAgent || DESKTOP_UA).trim() || DESKTOP_UA,
  }
  const referrer = String(extra?.referrer || '').trim()
  if (referrer) {
    headers.Referer = referrer
    try {
      headers.Origin = extra?.origin || new URL(referrer).origin
    } catch {
      /* ignore */
    }
  }
  return headers
}

function isPlaylistContext(context: LoaderContext): boolean {
  const type = String((context as { type?: string }).type || '').toLowerCase()
  // hls.js playlist loads declare a playlist type — trust that first.
  if (
    type === 'manifest' ||
    type === 'level' ||
    type === 'audiotrack' ||
    type === 'subtitletrack' ||
    type === 'subtitle'
  ) {
    return true
  }
  // Aphrodite serves AES keys, init maps, and media segments from /cdn-m3u8?payload=
  // (same path as playlists). Never treat those binary loads as text.
  if (
    type === 'key' ||
    type === 'fragment' ||
    type === 'segment' ||
    type === 'initsegment' ||
    'frag' in context ||
    'keyInfo' in context ||
    'decryptdata' in context
  ) {
    return false
  }
  // responseType from hls.js is authoritative when present.
  const responseType = String((context as { responseType?: string }).responseType || '').toLowerCase()
  if (responseType === 'arraybuffer' || responseType === 'blob') return false
  if (responseType === 'text') return true

  const url = context.url || ''
  // Standard extension playlists.
  if (/\.m3u8(\?|$)/i.test(url)) return true
  // Aphrodite /cdn-m3u8 without a playlist `type` is ambiguous (playlist OR
  // AES key / fMP4 segment). Prefer binary — mangled keys cause eternal Buffering.
  return false
}

/** Loader that restores context.url so relative m3u8/.ts paths stay on the CDN. */
export function createAndroidSafeHlsLoader(
  playbackHeaders?: AndroidHlsPlaybackHeaders,
): HlsConfig['loader'] {
  const Base = Hls.DefaultConfig.loader
  const nativeHeaders = buildNativeHeaders(playbackHeaders)

  return class AndroidSafeHlsLoader extends Base {
    private abortCtrl: AbortController | null = null

    load(
      context: LoaderContext,
      config: LoaderConfiguration,
      callbacks: LoaderCallbacks<LoaderContext>,
    ) {
      // Always use CapacitorHttp on Android — XHR cannot set Referer, and some
      // CDNs (Movy) / IPTV hosts also need a real desktop UA from OkHttp.
      if (isAndroidCapacitor()) {
        void this.loadNative(context, config, callbacks)
        return
      }

      const onSuccess = callbacks.onSuccess
      callbacks.onSuccess = (response, stats, ctx, networkDetails) => {
        if (response && ctx?.url) {
          response.url = ctx.url
        }
        onSuccess(response, stats, ctx, networkDetails)
      }
      super.load(context, config, callbacks)
    }

    abort() {
      try {
        this.abortCtrl?.abort()
      } catch {
        /* ignore */
      }
      this.abortCtrl = null
      try {
        super.abort()
      } catch {
        /* ignore */
      }
    }

    private async loadNative(
      context: LoaderContext,
      config: LoaderConfiguration,
      callbacks: LoaderCallbacks<LoaderContext>,
    ) {
      const stats: LoaderStats = {
        aborted: false,
        loaded: 0,
        retry: 0,
        total: 0,
        chunkCount: 0,
        bwEstimate: 0,
        loading: { start: performance.now(), first: 0, end: 0 },
        parsing: { start: 0, end: 0 },
        buffering: { start: 0, first: 0, end: 0 },
      }
      this.abortCtrl = new AbortController()
      const timeoutMs = Math.max(8_000, Number(config.timeout) || 20_000)
      const timer = window.setTimeout(() => this.abortCtrl?.abort(), timeoutMs)

      try {
        const playlist = isPlaylistContext(context)
        const reqHeaders = { ...nativeHeaders }
        if (
          typeof context.rangeStart === 'number' &&
          typeof context.rangeEnd === 'number' &&
          context.rangeEnd > context.rangeStart
        ) {
          reqHeaders.Range = `bytes=${context.rangeStart}-${context.rangeEnd - 1}`
        }
        const res = await CapacitorHttp.get({
          url: context.url,
          headers: reqHeaders,
          responseType: playlist ? 'text' : 'arraybuffer',
          connectTimeout: timeoutMs,
          readTimeout: timeoutMs,
        })
        window.clearTimeout(timer)
        if (this.abortCtrl?.signal.aborted) {
          stats.aborted = true
          callbacks.onAbort?.(stats, context, null)
          return
        }
        if (res.status < 200 || res.status >= 300) {
          callbacks.onError(
            { code: res.status, text: `HTTP ${res.status}` },
            context,
            null,
            stats,
          )
          return
        }

        let data: string | ArrayBuffer
        if (playlist) {
          data = typeof res.data === 'string' ? res.data : String(res.data ?? '')
          const body = String(data).trim()
          // Movy paleoak often returns 200/400 text "Please wait file process." — not a playlist.
          // Atlantic edge may return the Cloudflare Warp interstitial HTML instead of m3u8.
          if (
            !body ||
            looksLikeAtlanticWarpPage(body) ||
            /please wait|file process|not (yet )?ready|processing/i.test(body) ||
            !/#EXTM3U/i.test(body)
          ) {
            callbacks.onError(
              {
                code: res.status || 502,
                text: looksLikeAtlanticWarpPage(body)
                  ? 'Atlantic Warp interstitial (not HLS)'
                  : 'Invalid HLS playlist (CDN not ready)',
              },
              context,
              null,
              stats,
            )
            return
          }
        } else if (typeof res.data === 'string') {
          // Capacitor may base64-encode binary when not using arraybuffer path.
          const bin = atob(res.data)
          const bytes = new Uint8Array(bin.length)
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
          data = bytes.buffer
        } else {
          data = res.data as ArrayBuffer
        }

        stats.loading.first = performance.now()
        stats.loading.end = stats.loading.first
        stats.loaded = typeof data === 'string' ? data.length : data.byteLength
        stats.total = stats.loaded

        const response: LoaderResponse = {
          url: context.url,
          data,
        }
        callbacks.onSuccess(response, stats, context, null)
      } catch (err) {
        window.clearTimeout(timer)
        if (this.abortCtrl?.signal.aborted) {
          stats.aborted = true
          callbacks.onAbort?.(stats, context, null)
          return
        }
        callbacks.onError(
          {
            code: 0,
            text: err instanceof Error ? err.message : 'Android HLS load failed',
          },
          context,
          null,
          stats,
        )
      } finally {
        this.abortCtrl = null
      }
    }
  }
}

/** Shared hls.js options for Android WebView (TVJ / IPTV / Movy / any relative HLS). */
export function androidHlsConfig(
  overrides?: Partial<HlsConfig>,
  playbackHeaders?: AndroidHlsPlaybackHeaders,
): Partial<HlsConfig> {
  if (!isAndroidCapacitor()) return overrides ?? {}
  return {
    enableWorker: false,
    lowLatencyMode: false,
    loader: createAndroidSafeHlsLoader(playbackHeaders),
    ...overrides,
  }
}
