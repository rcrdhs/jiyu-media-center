import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

const root = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  version?: string
}
const appVersion = pkg.version || '0.0.0'

/**
 * Continue-watching sync host baked into every build (desktop, Android, web).
 * Order: VITE_JIYU_SYNC_URL env → .env* files → committed config/public-sync.json.
 * Only a public https Worker URL — never a token.
 */
function resolveSyncUrl(mode: string): string {
  const fromEnv =
    process.env.VITE_JIYU_SYNC_URL || loadEnv(mode, root, 'VITE_JIYU_').VITE_JIYU_SYNC_URL || ''
  if (fromEnv.trim()) return fromEnv.trim()
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(root, 'config', 'public-sync.json'), 'utf8'),
    ) as { syncUrl?: string }
    return String(cfg.syncUrl || '').trim()
  } catch {
    return ''
  }
}

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: './',
  // Electron reads TMDB_API_KEY from .env; expose the same key to the Vite
  // bundle so Android/Capacitor can sync TMDB shelves without Electron IPC.
  // WYZIE_PROXY_URL is a public Worker URL (no secret). Never expose WYZIE_API_KEY.
  envPrefix: ['VITE_', 'TMDB_', 'WYZIE_PROXY_'],
  define: {
    __JIYU_VERSION__: JSON.stringify(appVersion),
    // Same Continue-watching sync host for Android, desktop, future TV/Apple.
    __JIYU_SYNC_URL__: JSON.stringify(resolveSyncUrl(mode)),
  },
  resolve: {
    alias: {
      'mpegts.js': path.resolve(root, 'vendor/mpegts/mpegts.js'),
    },
  },
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: true,
    watch: {
      // Scratch HTML, Capacitor copies, and packaged installers must not reload
      // or lock the desktop dev server (EBUSY on release/*.exe during pack).
      ignored: [
        '**/scripts/**',
        '**/android/**',
        '**/ios/**',
        '**/tizen/**',
        '**/release/**',
        '**/release-pack/**',
        '**/dist/**',
        // Worker sources / wrangler output are not part of the app bundle; atomic-replace
        // temp files must not trip the watcher either (dev server exit 1 at 11:50 on 2026-10-20).
        '**/workers/**',
        '**/*.jt-tmp',
      ],
    },
  },
  build: {
    outDir: 'dist',
    commonjsOptions: {
      include: [/vendor/, /node_modules/],
    },
  },
  optimizeDeps: {
    include: ['mpegts.js'],
  },
}))
