import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Capacitor } from '@capacitor/core'
import { useCatalog } from '../context/CatalogContext'
import { subscribeFavoriteTeams } from '../lib/favoriteTeams'
import {
  clearFavoriteMatchNotifications,
  syncFavoriteMatchNotifications,
} from '../lib/favoriteNotify'

/** Schedules favorite-team alerts and opens the match when one is tapped. */
export function FavoriteMatchAlerts() {
  const { items, ready } = useCatalog()
  const navigate = useNavigate()
  const itemsRef = useRef(items)
  itemsRef.current = items

  useEffect(() => {
    if (!ready) return
    let timer = 0
    let debounce = 0
    const run = () => {
      void syncFavoriteMatchNotifications(itemsRef.current)
    }
    // Catalog sync rewrites `items` constantly — debounce so we don't stack alerts.
    debounce = window.setTimeout(run, 1500)
    const unsub = subscribeFavoriteTeams(() => {
      window.clearTimeout(debounce)
      debounce = window.setTimeout(run, 400)
    })
    timer = window.setInterval(run, 60_000)
    return () => {
      unsub()
      window.clearTimeout(debounce)
      window.clearInterval(timer)
    }
  }, [ready, items.length])

  useEffect(() => {
    // One-shot: clear sticky/orphan favorite alerts left by older builds.
    void clearFavoriteMatchNotifications().then(() => {
      if (ready) void syncFavoriteMatchNotifications(itemsRef.current)
    })
  }, [ready])

  useEffect(() => {
    let remove: (() => void) | undefined
    let cancelled = false
    ;(async () => {
      try {
        if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return
        const { LocalNotifications } = await import('@capacitor/local-notifications')
        const handle = await LocalNotifications.addListener(
          'localNotificationActionPerformed',
          (event) => {
            const itemId = String(event.notification.extra?.itemId || '')
            if (!itemId) return
            navigate(`/watch/${encodeURIComponent(itemId)}`)
          },
        )
        if (cancelled) {
          void handle.remove()
          return
        }
        remove = () => {
          void handle.remove()
        }
      } catch {
        /* plugin unavailable */
      }
    })()
    return () => {
      cancelled = true
      remove?.()
    }
  }, [navigate])

  return null
}
