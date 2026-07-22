import { useNavigate } from 'react-router-dom'
import type { StreamItem } from '../types'
import { WEB_PRESETS, isDesktopApp, liveUrlForChannelTitle } from '../lib/webBrowser'

/** Always route through the in-app Web browser page — never openExternal from here */
function openInAppBrowser(navigate: ReturnType<typeof useNavigate>, url: string) {
  navigate(`/web?url=${encodeURIComponent(url)}`)
}

export function LocalVideoSources({ channels }: { channels: StreamItem[] }) {
  const navigate = useNavigate()
  const desktop = isDesktopApp()

  return (
    <div className="local-video-sources">
      <div className="local-video-sources-head">
        <h3>YouTube & official sources</h3>
        <p>
          {desktop
            ? 'Opens the current live stream inside Jiyu’s 6″×4″ player tile.'
            : 'Open in Jiyu Web browser (use the desktop app for in-app viewing).'}
        </p>
      </div>

      <div className="local-video-source-grid">
        {channels.map((channel) => (
          <button
            key={`youtube-${channel.id}`}
            type="button"
            className="local-source-btn"
            onClick={() => openInAppBrowser(navigate, liveUrlForChannelTitle(channel.title))}
          >
            <strong>Play {channel.title.replace(/\s*[\[(].*$/, '')} live</strong>
            <span>Current stream in Web browser</span>
          </button>
        ))}

        {WEB_PRESETS.filter(
          (p) =>
            p.id === 'cvm-live' ||
            p.id === '1spot-live' ||
            p.id === 'tvj-live' ||
            p.id === 'nationwide-live',
        ).map((source) => (
          <button
            key={source.id}
            type="button"
            className="local-source-btn"
            onClick={() => openInAppBrowser(navigate, source.url)}
          >
            <strong>{source.label}</strong>
            <span>{source.detail}</span>
          </button>
        ))}

        <button type="button" className="local-source-btn" onClick={() => navigate('/web')}>
          <strong>Open Web browser</strong>
          <span>Live tile + fullscreen</span>
        </button>
      </div>
    </div>
  )
}
