import { useEffect, useRef, useState } from 'react'
import {
  getCachedTmdbTvIdForTitle,
  getCachedTmdbTvNetworks,
  loadTmdbTvNetworks,
  resolveTmdbTvIdForTitle,
  type TmdbTvNetworkInfo,
} from '../lib/tmdbTv'

const CARD_LOGO_SIZE = 'w92'

function knownTmdbId(tmdbId: string, searchTitle: string, releasedAt?: number): string | undefined {
  if (tmdbId) return tmdbId
  if (!searchTitle) return ''
  return getCachedTmdbTvIdForTitle(searchTitle, releasedAt)
}

/**
 * Network logo chip on a TV poster (Netflix, HBO, Apple TV+, ...).
 * Reads the shared cache first; otherwise asks TMDB once the card is near the
 * viewport (queued, 2 at a time, cached ~30 days). Rows without a TMDB id
 * (M2Box) pass `searchTitle` and resolve the id by title first.
 */
export function CardNetworkBadge({
  tmdbId = '',
  searchTitle = '',
  releasedAt,
  anchorRef,
}: {
  tmdbId?: string
  searchTitle?: string
  releasedAt?: number
  anchorRef: React.RefObject<HTMLElement | null>
}) {
  const [networks, setNetworks] = useState<TmdbTvNetworkInfo[] | undefined>(() => {
    const id = knownTmdbId(tmdbId, searchTitle, releasedAt)
    return id ? getCachedTmdbTvNetworks(id, CARD_LOGO_SIZE) : undefined
  })
  const [logoFailed, setLogoFailed] = useState(false)
  const visibleRef = useRef(false)

  useEffect(() => {
    setLogoFailed(false)
    const known = knownTmdbId(tmdbId, searchTitle, releasedAt)
    if (known === '') {
      setNetworks(undefined)
      return
    }
    const cached = known ? getCachedTmdbTvNetworks(known, CARD_LOGO_SIZE) : undefined
    setNetworks(cached)
    if (cached) return
    const el = anchorRef.current
    let cancelled = false
    let requested = false
    const isWanted = () => !cancelled && visibleRef.current
    const request = () => {
      if (requested) return
      requested = true
      void (async () => {
        let id = known
        if (!id) {
          id = await resolveTmdbTvIdForTitle(searchTitle, releasedAt, { isWanted })
          if (cancelled) return
          if (id === '') return // TMDB has no confident match - no chip
          if (!id) {
            requested = false // dropped while off-screen / failed: retry when seen again
            return
          }
        }
        const rows = await loadTmdbTvNetworks(id, { logoSize: CARD_LOGO_SIZE, isWanted })
        if (cancelled) return
        if (rows) setNetworks(rows)
        else requested = false
      })()
    }
    if (!el || typeof IntersectionObserver === 'undefined') {
      visibleRef.current = true
      request()
      return () => {
        cancelled = true
      }
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((e) => e.isIntersecting)
        visibleRef.current = visible
        if (visible) request()
      },
      { rootMargin: '240px 0px' },
    )
    observer.observe(el)
    return () => {
      cancelled = true
      observer.disconnect()
    }
  }, [tmdbId, searchTitle, releasedAt, anchorRef])

  const primary = networks?.[0]
  if (!primary) return null
  const logo = !logoFailed ? primary.logoUrl : undefined
  return (
    <span className={`media-card-network${logo ? ' has-logo' : ''}`} title={primary.name}>
      {logo ? (
        <img
          src={logo}
          alt={primary.name}
          loading="lazy"
          decoding="async"
          onError={() => setLogoFailed(true)}
        />
      ) : (
        primary.name
      )}
    </span>
  )
}
