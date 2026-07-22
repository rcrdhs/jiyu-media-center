import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { useCatalog } from './CatalogContext'
import {
  extractEpgUrlsFromM3U,
  fetchEpgXml,
  getManualEpgUrl,
  matchEpgChannelId,
  nowNext,
  parseXmltvAsync,
  setManualEpgUrl,
  type EpgData,
  type EpgProgramme,
} from '../lib/epg'
import type { StreamItem } from '../types'

interface EpgContextValue {
  data: EpgData | null
  loading: boolean
  error: string | null
  manualUrl: string
  setManualUrl: (url: string) => void
  discoveredUrls: string[]
  activeUrl: string | null
  refresh: (url?: string) => Promise<void>
  channelIdFor: (item: StreamItem) => string | null
  nowNextFor: (item: StreamItem) => { now?: EpgProgramme; next?: EpgProgramme }
}

const EpgContext = createContext<EpgContextValue | null>(null)

export function EpgProvider({ children }: { children: ReactNode }) {
  const { sources } = useCatalog()
  const [data, setData] = useState<EpgData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [manualUrl, setManualUrlState] = useState(() => getManualEpgUrl())

  const discoveredUrls = useMemo(() => {
    const urls: string[] = []
    for (const source of sources) {
      urls.push(...extractEpgUrlsFromM3U(source.content))
    }
    return [...new Set(urls)]
  }, [sources])

  const activeUrl = manualUrl.trim() || discoveredUrls[0] || null

  const setManualUrl = useCallback((url: string) => {
    setManualEpgUrl(url)
    setManualUrlState(url)
  }, [])

  const refresh = useCallback(
    async (url?: string) => {
      const target = (url ?? activeUrl)?.trim()
      if (!target) {
        setError('Add an EPG (XMLTV) URL in Library, or import a playlist with url-tvg.')
        setData(null)
        return
      }
      setLoading(true)
      setError(null)
      try {
        const xml = await fetchEpgXml(target)
        const parsed = await parseXmltvAsync(xml, target)
        if (parsed.programmes.length === 0 && parsed.channels.length === 0) {
          throw new Error('EPG loaded but contained no programmes')
        }
        setData(parsed)
      } catch (err) {
        setData(null)
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    },
    [activeUrl],
  )

  const channelIdFor = useCallback(
    (item: StreamItem) => {
      if (!data) return null
      return matchEpgChannelId(item, data)
    },
    [data],
  )

  const nowNextFor = useCallback(
    (item: StreamItem) => {
      if (!data) return {}
      const id = matchEpgChannelId(item, data)
      if (!id) return {}
      return nowNext(data, id)
    },
    [data],
  )

  const value = useMemo(
    () => ({
      data,
      loading,
      error,
      manualUrl,
      setManualUrl,
      discoveredUrls,
      activeUrl,
      refresh,
      channelIdFor,
      nowNextFor,
    }),
    [
      data,
      loading,
      error,
      manualUrl,
      setManualUrl,
      discoveredUrls,
      activeUrl,
      refresh,
      channelIdFor,
      nowNextFor,
    ],
  )

  return <EpgContext.Provider value={value}>{children}</EpgContext.Provider>
}

export function useEpg() {
  const ctx = useContext(EpgContext)
  if (!ctx) throw new Error('useEpg must be used inside EpgProvider')
  return ctx
}
