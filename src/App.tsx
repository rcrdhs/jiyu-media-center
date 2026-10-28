import { useEffect } from 'react'
import { HashRouter, Navigate, Route, Routes, useParams } from 'react-router-dom'
import { CatalogProvider } from './context/CatalogContext'
import { StreamHealthProvider } from './context/StreamHealthContext'
import { PlaybackProvider } from './context/PlaybackContext'
import { EpgProvider } from './context/EpgContext'
import { WebBrowserProvider } from './context/WebBrowserContext'
import { Sidebar } from './components/Sidebar'
import { KidsModeGate } from './components/KidsModeGate'
import { BillingGate } from './components/BillingGate'
import { GlobalPlayer } from './components/GlobalPlayer'
import { WebBrowserPip } from './components/WebBrowserPip'
import { NavigationPiPBridge } from './components/NavigationPiPBridge'
import { MinimizeToPipBridge } from './components/MinimizeToPipBridge'
import { AndroidBackBridge } from './components/AndroidBackBridge'
import { SystemPipBridge } from './components/SystemPipBridge'
import { BackToTop } from './components/BackToTop'
import { HomePage } from './pages/HomePage'
import { SectionPage } from './pages/SectionPage'
import { WatchPage } from './pages/WatchPage'
import { ShowPage } from './pages/ShowPage'
import { LibraryPage } from './pages/LibraryPage'
import { AccountPage } from './pages/AccountPage'
import { BrowsePage } from './pages/BrowsePage'
import { WebBrowserPage } from './pages/WebBrowserPage'
import { NativeStreamPage } from './pages/NativeStreamPage'
import { MultiviewPage } from './pages/MultiviewPage'
import { FORCE_SAVE_CONTINUE_EVENT } from './lib/continueWatching'
import { ensurePerformanceProfile } from './lib/deviceProfile'
import { startProgressSync } from './lib/progressSync'
import { FavoriteMatchAlerts } from './components/FavoriteMatchAlerts'
import { WelcomeTour } from './components/WelcomeTour'
import { TvNavBridge } from './components/TvNavBridge'

function SectionRoute() {
  const { id } = useParams()
  return <SectionPage key={id} />
}

/** Flush Continue watching when Electron is about to close the window. */
function DesktopContinueSaveBridge() {
  useEffect(() => {
    const api = window.signalDesktop
    if (!api?.onSaveContinue) return
    return api.onSaveContinue(() => {
      window.dispatchEvent(new Event(FORCE_SAVE_CONTINUE_EVENT))
      // Let the Player persist handler run before acknowledging.
      window.setTimeout(() => {
        api.continueSaved?.()
      }, 50)
    })
  }, [])
  return null
}

/** Detect CPU/RAM/battery and push torrent/sync knobs into Electron. */
function DevicePerformanceBridge() {
  useEffect(() => {
    void ensurePerformanceProfile()
  }, [])
  return null
}

/** Cross-device Continue watching sync (no-op until a sync server is set). */
function ProgressSyncBridge() {
  useEffect(() => startProgressSync(), [])
  return null
}

export default function App() {
  return (
    <CatalogProvider>
      <StreamHealthProvider>
        <EpgProvider>
          <PlaybackProvider>
            <HashRouter>
              <WebBrowserProvider>
                <NavigationPiPBridge />
                <MinimizeToPipBridge />
                <AndroidBackBridge />
                <TvNavBridge />
                <SystemPipBridge />
                <div className="app-shell">
                  <Sidebar />
                  <main className="main-stage">
                    <KidsModeGate>
                      <BillingGate>
                        <Routes>
                          <Route path="/" element={<HomePage />} />
                          <Route path="/section/:id" element={<SectionRoute />} />
                          <Route path="/show/:id" element={<ShowPage />} />
                          <Route path="/watch/:id" element={<WatchPage />} />
                          <Route path="/library" element={<LibraryPage />} />
                          <Route path="/account" element={<AccountPage />} />
                          <Route path="/browse" element={<BrowsePage />} />
                          <Route path="/web" element={<WebBrowserPage />} />
                          <Route path="/native-stream" element={<NativeStreamPage />} />
                          <Route path="/guide" element={<Navigate to="/" replace />} />
                          <Route path="/torrents" element={<Navigate to="/library?section=websites" replace />} />
                          <Route path="/multiview" element={<MultiviewPage />} />
                          <Route path="*" element={<Navigate to="/" replace />} />
                        </Routes>
                      </BillingGate>
                    </KidsModeGate>
                  </main>
                  <BackToTop />
                  <GlobalPlayer />
                  <WebBrowserPip />
                  <DesktopContinueSaveBridge />
                  <DevicePerformanceBridge />
                  <ProgressSyncBridge />
                  <FavoriteMatchAlerts />
                  <WelcomeTour />
                </div>
              </WebBrowserProvider>
            </HashRouter>
          </PlaybackProvider>
        </EpgProvider>
      </StreamHealthProvider>
    </CatalogProvider>
  )
}
