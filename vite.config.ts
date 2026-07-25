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
