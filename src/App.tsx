import { HashRouter, Navigate, Route, Routes, useParams } from 'react-router-dom'
import { CatalogProvider } from './context/CatalogContext'
import { StreamHealthProvider } from './context/StreamHealthContext'
import { PlaybackProvider } from './context/PlaybackContext'
import { EpgProvider } from './context/EpgContext'
import { Sidebar } from './components/Sidebar'
import { GlobalPlayer } from './components/GlobalPlayer'
import { HomePage } from './pages/HomePage'
import { SectionPage } from './pages/SectionPage'
import { WatchPage } from './pages/WatchPage'
import { ShowPage } from './pages/ShowPage'
import { LibraryPage } from './pages/LibraryPage'
import { BrowsePage } from './pages/BrowsePage'
import { WebBrowserPage } from './pages/WebBrowserPage'
import { GuidePage } from './pages/GuidePage'
import { MultiviewPage } from './pages/MultiviewPage'
import { TorrentsPage } from './pages/TorrentsPage'

function SectionRoute() {
  const { id } = useParams()
  return <SectionPage key={id} />
}

export default function App() {
  return (
    <CatalogProvider>
      <StreamHealthProvider>
        <EpgProvider>
          <PlaybackProvider>
            <HashRouter>
              <div className="app-shell">
                <Sidebar />
                <main className="main-stage">
                  <Routes>
                    <Route path="/" element={<HomePage />} />
                    <Route path="/section/:id" element={<SectionRoute />} />
                    <Route path="/show/:id" element={<ShowPage />} />
                    <Route path="/watch/:id" element={<WatchPage />} />
                    <Route path="/library" element={<LibraryPage />} />
                    <Route path="/browse" element={<BrowsePage />} />
                    <Route path="/web" element={<WebBrowserPage />} />
                    <Route path="/guide" element={<GuidePage />} />
                    <Route path="/torrents" element={<TorrentsPage />} />
                    <Route path="/multiview" element={<MultiviewPage />} />
                    <Route path="*" element={<Navigate to="/" replace />} />
                  </Routes>
                </main>
                <GlobalPlayer />
              </div>
            </HashRouter>
          </PlaybackProvider>
        </EpgProvider>
      </StreamHealthProvider>
    </CatalogProvider>
  )
}
