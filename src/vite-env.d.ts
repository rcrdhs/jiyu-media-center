/// <reference types="vite/client" />

/** Injected from package.json by vite.config.ts */
declare const __JIYU_VERSION__: string

interface ImportMetaEnv {
  readonly TMDB_API_KEY?: string
  readonly TMDB_KEY?: string
  readonly VITE_TMDB_API_KEY?: string
  /** Public Cloudflare Worker URL for Wyzie (no API key). */
  readonly WYZIE_PROXY_URL?: string
  readonly VITE_WYZIE_PROXY_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
