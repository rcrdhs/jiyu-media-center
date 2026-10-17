/**
 * Android Media3 / ExoPlayer overlay — plays direct HLS/DASH/progressive URLs
 * after Gecko unwraps sports embeds.
 */

import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'

export type Media3PlaybackEvent = {
  state: 'loading' | 'buffering' | 'playing' | 'ended' | 'idle' | 'error' | string
  detail?: string
}

type Media3PlayerPlugin = {
  show: (bounds?: {
    x?: number
    y?: number
    width?: number
    height?: number
  }) => Promise<{ ok: boolean; error?: string }>
  hide: (options?: { stop?: boolean }) => Promise<{ ok: boolean }>
  setBounds: (bounds: {
    x?: number
    y?: number
    width?: number
    height?: number
  }) => Promise<{ ok: boolean }>
  play: (options: {
    url: string
    title?: string
    referrer?: string
    userAgent?: string
    headers?: Record<string, string>
    x?: number
    y?: number
    width?: number
    height?: number
  }) => Promise<{ ok: boolean; error?: string }>
  pause: () => Promise<{ ok: boolean }>
  resume: () => Promise<{ ok: boolean }>
  stop: () => Promise<{ ok: boolean }>
  setVolume: (options: { percent: number }) => Promise<{ ok: boolean; percent?: number }>
  getState: () => Promise<{
    ok: boolean
    playing?: boolean
    url?: string
    position?: number
    volume?: number
    visible?: boolean
  }>
  addListener: (
    event: 'playback',
    listener: (ev: Media3PlaybackEvent) => void,
  ) => Promise<PluginListenerHandle>
}

const NativeMedia3 = registerPlugin<Media3PlayerPlugin>('Media3Player')

export function isAndroidMedia3Host(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
  } catch {
    return false
  }
}

export async function media3Show(bounds?: {
  x?: number
  y?: number
  width?: number
  height?: number
}) {
  if (!isAndroidMedia3Host()) return { ok: false as const, error: 'Not Android' }
  return NativeMedia3.show(bounds)
}

export async function media3Hide(options?: { stop?: boolean }) {
  if (!isAndroidMedia3Host()) return { ok: false as const }
  return NativeMedia3.hide(options)
}

export async function media3SetBounds(bounds: {
  x?: number
  y?: number
  width?: number
  height?: number
}) {
  if (!isAndroidMedia3Host()) return { ok: false as const }
  return NativeMedia3.setBounds(bounds)
}

export async function media3Play(options: {
  url: string
  title?: string
  referrer?: string
  userAgent?: string
  headers?: Record<string, string>
  x?: number
  y?: number
  width?: number
  height?: number
}) {
  if (!isAndroidMedia3Host()) return { ok: false as const, error: 'Not Android' }
  return NativeMedia3.play(options)
}

export async function media3Pause() {
  if (!isAndroidMedia3Host()) return { ok: false as const }
  return NativeMedia3.pause()
}

export async function media3Resume() {
  if (!isAndroidMedia3Host()) return { ok: false as const }
  return NativeMedia3.resume()
}

export async function media3Stop() {
  if (!isAndroidMedia3Host()) return { ok: false as const }
  return NativeMedia3.stop()
}

export async function media3SetVolume(percent: number) {
  if (!isAndroidMedia3Host()) return { ok: false as const }
  return NativeMedia3.setVolume({ percent })
}

export async function media3GetState() {
  if (!isAndroidMedia3Host()) return { ok: false as const }
  return NativeMedia3.getState()
}

export function media3OnPlayback(listener: (ev: Media3PlaybackEvent) => void) {
  if (!isAndroidMedia3Host()) return Promise.resolve({ remove: async () => undefined })
  return NativeMedia3.addListener('playback', listener)
}
