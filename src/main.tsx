import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Capacitor } from '@capacitor/core'
import './index.css'
import App from './App'
import { initTvMode } from './lib/tvMode'
import { installTizenFetchRelay } from './lib/tizenRelay'

try {
  if (Capacitor.isNativePlatform()) {
    document.documentElement.classList.add('is-native')
    document.documentElement.classList.add(`is-${Capacitor.getPlatform()}`)
    document.body.classList.add('is-native')
    document.body.classList.add(`is-${Capacitor.getPlatform()}`)
  }
} catch {
  /* browser / desktop Vite */
}

// Android TV / Google TV / Fire TV → html.tv-mode (no-op on phones & desktop).
try {
  initTvMode()
} catch {
  /* ignore */
}

// Samsung only: CORS-blocked scraper hosts go through the jiyu-relay Worker.
try {
  installTizenFetchRelay()
} catch {
  /* ignore */
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
