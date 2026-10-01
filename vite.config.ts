import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const root = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  version?: string
}
const appVersion = pkg.version || '0.0.0'

export default defineConfig({
  plugins: [react()],
  base: './',
  // Electron reads TMDB_API_KEY from .env; expose the same key to the Vite
  // bundle so Android/Capacitor can sync TMDB shelves without Electron IPC.
  // WYZIE_PROXY_URL is a public Worker URL (no secret). Never expose WYZIE_API_KEY.
  envPrefix: ['VITE_', 'TMDB_', 'WYZIE_PROXY_'],
  define: {
    __JIYU_VERSION__: JSON.stringify(appVersion),
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
})
