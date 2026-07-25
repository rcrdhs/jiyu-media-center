import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { StreamItem } from '../types'

export type PlaybackMode = 'off' | 'full' | 'pip' | 'multi'

const MAX_SLOTS = 4

interface PlaybackState {
  slots: StreamItem[]
  primaryId: string | null
  mode: PlaybackMode
  /** When true, the next play() adds a tile instead of replacing */
  awaitingAdd: boolean
  /** Route to open when leaving the full player (e.g. /guide) */
  returnTo: string | null
  /** Stream displaced when opening another from Guide — restore on Back */
  resumeItem: StreamItem | null
}

export interface PlayOptions {
  /** Always open the full-stage player (ignore current PiP mode) */
  forceFull?: boolean
  /** Where Back should go after full playback */
  returnTo?: string | null
}

interface PlaybackContextValue {
  item: StreamItem | null
  slots: StreamItem[]
  primaryId: string | null
  mode: PlaybackMode
  awaitingAdd: boolean
  returnTo: string | null
  resumeItem: StreamItem | null
  play: (item: StreamItem, options?: PlayOptions) => void
  addToMultiview: (item: StreamItem) => void
  armMultiviewAdd: () => void
  cancelMultiviewAdd: () => void
  minimizeToPip: () => void
  expand: () => void
  stop: () => void
  spotlight: (id: string) => void
  removeSlot: (id: string) => void
  clearReturnTo: () => void
  /** Leave a Guide-opened watch: restore prior stream to PiP and return to Guide */
  leaveGuideWatch: () => StreamItem | null
  /** Restore resume/PiP stream to full player; returns item to navigate to */
  resumePrevious: () => StreamItem | null
}

const PlaybackContext = createContext<PlaybackContextValue | null>(null)

function primaryOf(slots: StreamItem[], primaryId: string | null): StreamItem | null {
  if (!slots.length) return null
  return slots.find((s) => s.id === primaryId) ?? slots[0]
}

function addSlot(
  current: StreamItem[],
  next: StreamItem,
  primaryId: string | null,
): { slots: StreamItem[]; primaryId: string } {
  const keepPrimary =
    primaryId && current.some((s) => s.id === primaryId) ? primaryId : current[0]?.id ?? next.id

  if (current.some((s) => s.id === next.id)) {
    return {
      slots: current.map((s) => (s.id === next.id ? next : s)),
      primaryId: next.id,
    }
  }

  if (current.length === 0) {
    return { slots: [next], primaryId: next.id }
  }

  if (current.length < MAX_SLOTS) {
    return { slots: [...current, next], primaryId: keepPrimary }
  }

  const replaceIdx = current.findIndex((s) => s.id !== keepPrimary)
  const nextSlots = [...current]
  nextSlots[replaceIdx < 0 ? current.length - 1 : replaceIdx] = next
  return { slots: nextSlots, primaryId: keepPrimary }
}

const emptyState = (): PlaybackState => ({
  slots: [],
  primaryId: null,
  mode: 'off',
  awaitingAdd: false,
  returnTo: null,
  resumeItem: null,
})

export function PlaybackProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PlaybackState>(emptyState)
  const stateRef = useRef(state)
  stateRef.current = state

  const play = useCallback((next: StreamItem, options?: PlayOptions) => {
    setState((prev) => {
      const { slots: current, primaryId: pid, mode: m, awaitingAdd } = prev
      const inMultiview = current.length > 1 || m === 'multi'
      const shouldAdd = awaitingAdd || inMultiview
      const returnTo = options?.returnTo !== undefined ? options.returnTo : prev.returnTo
      const prevPrimary = primaryOf(current, pid)

      if (!shouldAdd) {
        const mode: PlaybackMode = options?.forceFull ? 'full' : m === 'pip' ? 'pip' : 'full'
        // Only Guide takeovers should restore the prior PiP on Back. A normal
        // forceFull watch (Sports, Movies, …) replaces PiP — don't bounce back.
        const fromGuide = options?.returnTo === '/guide'
        const resumeItem = options?.forceFull
          ? fromGuide && prevPrimary && prevPrimary.id !== next.id
            ? prevPrimary
            : null
          : prev.resumeItem

        return {
          slots: [next],
          primaryId: next.id,
          mode,
          awaitingAdd: false,
          returnTo,
          resumeItem: resumeItem ?? null,
        }
      }

      if (current.length === 0) {
        return {
          slots: [next],
          primaryId: next.id,
          mode: 'full',
          awaitingAdd: false,
          returnTo,
          resumeItem: prev.resumeItem,
        }
      }

      const added = addSlot(current, next, pid)
      return {
        slots: added.slots,
        primaryId: added.primaryId,
        mode: added.slots.length > 1 ? 'multi' : 'full',
        awaitingAdd: false,
        returnTo,
        resumeItem: prev.resumeItem,
      }
    })
  }, [])

  const addToMultiview = useCallback((next: StreamItem) => {
    setState((prev) => {
      const { slots: current, primaryId: pid } = prev
      if (current.length === 0) {
        return {
          slots: [next],
          primaryId: next.id,
          mode: 'full',
          awaitingAdd: true,
          returnTo: prev.returnTo,
          resumeItem: prev.resumeItem,
        }
      }
      const added = addSlot(current, next, pid)
      return {
        slots: added.slots,
        primaryId: added.primaryId,
        mode: added.slots.length > 1 ? 'multi' : 'full',
        awaitingAdd: false,
        returnTo: prev.returnTo,
        resumeItem: prev.resumeItem,
      }
    })
  }, [])

  const armMultiviewAdd = useCallback(() => {
    setState((prev) => ({ ...prev, awaitingAdd: true }))
  }, [])

  const cancelMultiviewAdd = useCallback(() => {
    setState((prev) => ({ ...prev, awaitingAdd: false }))
  }, [])

  const clearReturnTo = useCallback(() => {
    setState((prev) => ({ ...prev, returnTo: null }))
  }, [])

  const leaveGuideWatch = useCallback((): StreamItem | null => {
    const prev = stateRef.current
    const resume = prev.resumeItem
    if (resume) {
      setState({
        slots: [resume],
        primaryId: resume.id,
        mode: 'pip',
        awaitingAdd: false,
        returnTo: null,
        resumeItem: null,
      })
      return resume
    }
    setState(emptyState())
    return null
  }, [])

  const resumePrevious = useCallback((): StreamItem | null => {
    const prev = stateRef.current
    const resume = prev.resumeItem
    const pip = primaryOf(prev.slots, prev.primaryId)
    const next = resume ?? (prev.mode === 'pip' ? pip : null)
    if (!next) return null
    setState({
      slots: [next],
      primaryId: next.id,
      mode: 'full',
      awaitingAdd: false,
      returnTo: null,
      resumeItem: null,
    })
    return next
  }, [])

  const minimizeToPip = useCallback(() => {
    setState((prev) => {
      if (prev.mode === 'off' || prev.slots.length === 0) return prev
      const keep = prev.slots.find((s) => s.id === prev.primaryId) ?? prev.slots[0]
      return {
        slots: [keep],
        primaryId: keep.id,
        mode: 'pip',
        // Keep armed so "Multi-view → pick channel" still adds after minimizing
        awaitingAdd: prev.awaitingAdd,
        returnTo: null,
        resumeItem: prev.resumeItem,
      }
    })
  }, [])

  const expand = useCallback(() => {
    setState((prev) => {
      if (prev.slots.length === 0) return prev
      if (prev.slots.length > 1) return { ...prev, mode: 'multi' }
      return { ...prev, mode: 'full' }
    })
  }, [])

  const stop = useCallback(() => {
    setState(emptyState())
  }, [])

  const spotlight = useCallback((id: string) => {
    setState((prev) => {
      if (!prev.slots.some((s) => s.id === id)) return prev
      return { ...prev, primaryId: id }
    })
  }, [])

  const removeSlot = useCallback((id: string) => {
    setState((prev) => {
      const nextSlots = prev.slots.filter((s) => s.id !== id)
      if (nextSlots.length === 0) return emptyState()
      const nextPrimary =
        prev.primaryId && nextSlots.some((s) => s.id === prev.primaryId)
          ? prev.primaryId
          : nextSlots[0].id
      let nextMode = prev.mode
      if (nextSlots.length === 1) {
        nextMode = prev.mode === 'pip' ? 'pip' : 'full'
      } else if (prev.mode === 'full') {
        nextMode = 'multi'
      }
      return {
        slots: nextSlots,
        primaryId: nextPrimary,
        mode: nextMode,
        awaitingAdd: prev.awaitingAdd,
        returnTo: prev.returnTo,
        resumeItem: prev.resumeItem,
      }
    })
  }, [])

  const item = primaryOf(state.slots, state.primaryId)

  const value = useMemo(
    () => ({
      item,
      slots: state.slots,
      primaryId: state.primaryId,
      mode: state.mode,
      awaitingAdd: state.awaitingAdd,
      returnTo: state.returnTo,
      resumeItem: state.resumeItem,
      play,
      addToMultiview,
      armMultiviewAdd,
      cancelMultiviewAdd,
      minimizeToPip,
      expand,
      stop,
      spotlight,
      removeSlot,
      clearReturnTo,
      leaveGuideWatch,
      resumePrevious,
    }),
    [
      item,
      state.slots,
      state.primaryId,
      state.mode,
      state.awaitingAdd,
      state.returnTo,
      state.resumeItem,
      play,
      addToMultiview,
      armMultiviewAdd,
      cancelMultiviewAdd,
      minimizeToPip,
      expand,
      stop,
      spotlight,
      removeSlot,
      clearReturnTo,
      leaveGuideWatch,
      resumePrevious,
    ],
  )

  return <PlaybackContext.Provider value={value}>{children}</PlaybackContext.Provider>
}

export function usePlayback() {
  const ctx = useContext(PlaybackContext)
  if (!ctx) throw new Error('usePlayback must be used inside PlaybackProvider')
  return ctx
}
