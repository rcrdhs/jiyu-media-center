import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
  base: './',
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
