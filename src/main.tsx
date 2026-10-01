import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Capacitor } from '@capacitor/core'
import './index.css'
import App from './App'

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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
