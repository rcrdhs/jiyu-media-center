/** Local type shim for vendored mpegts.js (npm install needs git for a transitive dep). */
declare module 'mpegts.js' {
  export interface MediaDataSource {
    type: string
    isLive?: boolean
    url?: string
    withCredentials?: boolean
  }

  export interface Config {
    enableWorker?: boolean
    enableStashBuffer?: boolean
    stashInitialSize?: number
    liveBufferLatencyChasing?: boolean
    autoCleanupSourceBuffer?: boolean
  }

  export interface Player {
    attachMediaElement(media: HTMLMediaElement): void
    detachMediaElement(): void
    load(): void
    unload(): void
    play(): Promise<void>
    pause(): void
    destroy(): void
    on(event: string, listener: (...args: unknown[]) => void): void
  }

  interface MpegtsStatic {
    isSupported(): boolean
    getFeatureList(): { mseLivePlayback?: boolean }
    createPlayer(mediaDataSource: MediaDataSource, config?: Config): Player
    Events: {
      ERROR: string
      LOADING_COMPLETE: string
    }
  }

  const mpegts: MpegtsStatic
  export default mpegts
}
