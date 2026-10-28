import { useEffect, useRef, useState } from 'react'
import { TIZEN_MEDIA_KEY_EVENT } from '../lib/tvMode'
import { isTizenYouTubeEmbedUrl, tizenYouTubeEmbedFor } from '../lib/tizenRelay'

/**
 * Samsung (Tizen) /web surface: there is no Electron WebContentsView or Android
 * Gecko view, so embeds render in a plain iframe. YouTube goes through the relay's
 * https embed page (correct origin/referrer → no Error 153) and is driven by the
 * remote: OK / Play / Pause toggles, ◀ ▶ and Rewind / Fast-forward seek 10 s.
 * Focus stays in the app so Return keeps working (cross-origin frames would eat it).
 */
export function TizenWebFrame({ url, title }: { url: string; title?: string }) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const hitRef = useRef<HTMLDivElement>(null)
  const yt = tizenYouTubeEmbedFor(url)
  const src = yt || url
  const youtube = Boolean(yt && isTizenYouTubeEmbedUrl(yt))
  const [hint, setHint] = useState(youtube ? 'OK play / pause · ◀ ▶ seek 10 s' : '')

  const command = (func: string, args: unknown[] = []) => {
    try {
      frameRef.current?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args }), '*')
    } catch {
      /* frame gone */
    }
  }

  useEffect(() => {
    if (!hint) return
    const t = window.setTimeout(() => setHint(''), 4000)
    return () => window.clearTimeout(t)
  }, [hint])

  useEffect(() => {
    hitRef.current?.focus()
    // A cross-origin frame that grabs focus would swallow Return — take it back.
    const onBlur = () =>
      window.setTimeout(() => {
        if (document.activeElement === frameRef.current) hitRef.current?.focus()
      }, 0)
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [src])

  useEffect(() => {
    if (!youtube) return
    const onMedia = (ev: Event) => {
      const key = (ev as CustomEvent<{ key?: string }>).detail?.key
      if (key === 'play') command('playVideo')
      else if (key === 'pause' || key === 'stop') command('pauseVideo')
      else if (key === 'playpause') command('toggle')
      else if (key === 'forward' || key === 'next') command('seekBy', [10])
      else if (key === 'rewind' || key === 'previous') command('seekBy', [-10])
    }
    window.addEventListener(TIZEN_MEDIA_KEY_EVENT, onMedia)
    return () => window.removeEventListener(TIZEN_MEDIA_KEY_EVENT, onMedia)
  }, [youtube])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!youtube) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      command('toggle')
      setHint('')
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      command('seekBy', [-10])
      setHint('−10 s')
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      command('seekBy', [10])
      setHint('+10 s')
    }
  }

  return (
    <div className="tizen-web-frame" style={{ position: 'absolute', inset: 0, background: '#000' }}>
      <iframe
        ref={frameRef}
        src={src}
        title={title || 'Player'}
        tabIndex={-1}
        allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          border: 0,
          pointerEvents: youtube ? 'none' : 'auto',
        }}
      />
      <div
        ref={hitRef}
        tabIndex={0}
        className="tizen-web-frame-hit"
        aria-label={title || 'Player'}
        onKeyDown={onKeyDown}
        style={{ position: 'absolute', inset: 0, outline: 'none', pointerEvents: youtube ? 'auto' : 'none' }}
        onClick={() => youtube && command('toggle')}
      />
      {hint ? (
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: '6%',
            textAlign: 'center',
            color: '#fff',
            font: '600 26px/1.4 system-ui, sans-serif',
            textShadow: '0 2px 6px #000',
            pointerEvents: 'none',
          }}
        >
          {hint}
        </div>
      ) : null}
    </div>
  )
}
