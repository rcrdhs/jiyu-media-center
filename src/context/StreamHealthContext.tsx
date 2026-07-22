import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { DEFAULT_TIMEOUT_MS, probeStreamItems, probeStreamUrl } from '../lib/streamHealth'
import type { StreamHealthEntry, StreamHealthState, StreamItem } from '../types'

interface StreamHealthContextValue {
  getStatus: (id: string) => StreamHealthState
  getEntry: (id: string) => StreamHealthEntry | undefined
  checkingCount: number
  checkOne: (item: StreamItem) => Promise<StreamHealthEntry>
  checkMany: (items: StreamItem[]) => Promise<void>
  clear: () => void
}

const StreamHealthContext = createContext<StreamHealthContextValue | null>(null)

export function StreamHealthProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<Record<string, StreamHealthEntry>>({})
  const [checkingIds, setCheckingIds] = useState<Record<string, true>>({})
  const queueLock = useRef(Promise.resolve())

  const markChecking = useCallback((ids: string[]) => {
    setCheckingIds((prev) => {
      const next = { ...prev }
      for (const id of ids) next[id] = true
      return next
    })
  }, [])

  const clearChecking = useCallback((ids: string[]) => {
    setCheckingIds((prev) => {
      const next = { ...prev }
      for (const id of ids) delete next[id]
      return next
    })
  }, [])

  const applyProbes = useCallback((probes: Array<{ id: string } & Partial<StreamHealthEntry>>) => {
    const checkedAt = Date.now()
    setEntries((prev) => {
      const next = { ...prev }
      for (const probe of probes) {
        if (!probe?.id) continue
        next[probe.id] = {
          id: probe.id,
          ok: Boolean(probe.ok),
          state: probe.state ?? 'offline',
          status: probe.status ?? 0,
          latencyMs: probe.latencyMs ?? 0,
          error: probe.error ?? '',
          checkedAt,
        }
      }
      return next
    })
  }, [])

  const checkOne = useCallback(
    async (item: StreamItem) => {
      markChecking([item.id])
      try {
        const probe = await probeStreamUrl(item.url, DEFAULT_TIMEOUT_MS)
        const entry: StreamHealthEntry = {
          id: item.id,
          ...probe,
          checkedAt: Date.now(),
        }
        setEntries((prev) => ({ ...prev, [item.id]: entry }))
        return entry
      } finally {
        clearChecking([item.id])
      }
    },
    [clearChecking, markChecking],
  )

  const checkMany = useCallback(
    async (items: StreamItem[]) => {
      if (items.length === 0) return

      const run = async () => {
        const ids = items.map((item) => item.id)
        markChecking(ids)
        try {
          await probeStreamItems(items, {
            timeoutMs: DEFAULT_TIMEOUT_MS,
            onChunk: (chunk) => {
              applyProbes(chunk)
              clearChecking(chunk.map((c) => c.id))
            },
          })
        } finally {
          clearChecking(ids)
        }
      }

      // Don't serialize all shelf checks — overlap is fine for speed
      queueLock.current = Promise.resolve()
      await run()
    },
    [applyProbes, clearChecking, markChecking],
  )

  const clear = useCallback(() => {
    setEntries({})
    setCheckingIds({})
  }, [])

  const getEntry = useCallback((id: string) => entries[id], [entries])

  const getStatus = useCallback(
    (id: string): StreamHealthState => {
      if (checkingIds[id]) return 'checking'
      return entries[id]?.state ?? 'idle'
    },
    [checkingIds, entries],
  )

  const value = useMemo(
    () => ({
      getStatus,
      getEntry,
      checkingCount: Object.keys(checkingIds).length,
      checkOne,
      checkMany,
      clear,
    }),
    [getStatus, getEntry, checkingIds, checkOne, checkMany, clear],
  )

  return <StreamHealthContext.Provider value={value}>{children}</StreamHealthContext.Provider>
}

export function useStreamHealth() {
  const ctx = useContext(StreamHealthContext)
  if (!ctx) throw new Error('useStreamHealth must be used inside StreamHealthProvider')
  return ctx
}
