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
import {
  androidBrowserMultiSpotlight,
  isAndroidInAppBrowser,
} from '../lib/androidBrowser'

export type PlaybackMode = 'off' | 'full' | 'pip' | 'multi'

const MAX_SLOTS = 4

interface PlaybackState {
  slots: StreamItem[]
  primaryId: string | null
  mode: PlaybackMode
  /** When true, the next play() adds a tile instead of replacing */
  awaitingAdd: boolean
  /**
   * When mode is multi: full tile grid is on screen (mounted).
   * false = dismounted — browse the app; streams stay in memory / hidden views.
   */
  multiMounted: boolean
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
  /** Replace all slots (ignore armed multi-view / existing grid) */
  replace?: boolean
}

interface PlaybackContextValue {
  item: StreamItem | null
  slots: StreamItem[]
  primaryId: string | null
  mode: PlaybackMode
  awaitingAdd: boolean
  multiMounted: boolean
  returnTo: string | null
  resumeItem: StreamItem | null
  play: (item: StreamItem, options?: PlayOptions) => void
  addToMultiview: (item: StreamItem) => void
  armMultiviewAdd: () => void
  cancelMultiviewAdd: () => void
  /** Hide the multi grid and keep streams (browse / add). */
  dismountMulti: () => void
  /** Show the multi grid again with the same slots. */
  mountMulti: () => void
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
  multiMounted: true,
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
      const shouldAdd = !options?.replace && (awaitingAdd || inMultiview)
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
          multiMounted: true,
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
          multiMounted: true,
          returnTo,
          resumeItem: prev.resumeItem,
        }
      }

      const added = addSlot(current, next, pid)
      return {
        slots: added.slots,
        primaryId: added.primaryId,
        mode: added.slots.length > 1 ? 'multi' : prev.mode === 'multi' ? 'multi' : 'full',
        awaitingAdd: false,
        // Remount the grid when a stream is added from a dismounted session.
        multiMounted: true,
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
          multiMounted: true,
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
        multiMounted: true,
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

  const dismountMulti = useCallback(() => {
    setState((prev) => {
      if (prev.mode !== 'multi' || prev.slots.length === 0) return prev
      return { ...prev, multiMounted: false }
    })
  }, [])

  const mountMulti = useCallback(() => {
    setState((prev) => {
      if (prev.slots.length === 0) return prev
      return {
        ...prev,
        mode: prev.slots.length >= 1 ? 'multi' : prev.mode,
        multiMounted: true,
        awaitingAdd: false,
      }
    })
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
        multiMounted: true,
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
      multiMounted: true,
      returnTo: null,
      resumeItem: null,
    })
    return next
  }, [])

  const minimizeToPip = useCallback(() => {
    setState((prev) => {
      if (prev.mode === 'off' || prev.slots.length === 0) return prev
      // Multi-view grid must stay intact — collapsing here dropped the 2nd stream
      // when /watch → /multiview fired the navigation PiP bridge.
      if (prev.mode === 'multi' || prev.slots.length > 1) return prev
      const keep = prev.slots.find((s) => s.id === prev.primaryId) ?? prev.slots[0]
      return {
        slots: [keep],
        primaryId: keep.id,
        mode: 'pip',
        // Keep armed so "Multi-view → pick channel" still adds after minimizing
        awaitingAdd: prev.awaitingAdd,
        multiMounted: prev.multiMounted,
        returnTo: null,
        resumeItem: prev.resumeItem,
      }
    })
  }, [])

  const expand = useCallback(() => {
    setState((prev) => {
      if (prev.slots.length === 0) return prev
      if (prev.mode === 'multi' || prev.slots.length > 1) {
        return { ...prev, mode: 'multi', multiMounted: true }
      }
      return { ...prev, mode: 'full', multiMounted: true }
    })
  }, [])

  const stop = useCallback(() => {
    setState(emptyState())
  }, [])

  const spotlight = useCallback((id: string) => {
    setState((prev) => {
      if (!prev.slots.some((s) => s.id === id)) return prev
      if (prev.primaryId === id) return prev
      return { ...prev, primaryId: id }
    })
    void window.signalDesktop?.browserMultiSpotlight?.({ id })
    if (isAndroidInAppBrowser()) void androidBrowserMultiSpotlight({ id })
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
      let collapsed = false
      if (nextSlots.length === 1) {
        // One stream left: leave Multi-view and continue it in the normal player.
        // GlobalPlayer hands the live tile over (web embed promoted / same <video>),
        // so the survivor keeps playing instead of reloading.
        if (prev.mode === 'multi') {
          nextMode = 'full'
          collapsed = true
        } else nextMode = prev.mode === 'pip' ? 'pip' : 'full'
      } else if (prev.mode === 'full') {
        nextMode = 'multi'
      }
      return {
        slots: nextSlots,
        primaryId: collapsed ? nextSlots[0].id : nextPrimary,
        mode: nextMode,
        awaitingAdd: collapsed ? false : prev.awaitingAdd,
        multiMounted: collapsed ? true : prev.multiMounted,
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
      multiMounted: state.multiMounted,
      returnTo: state.returnTo,
      resumeItem: state.resumeItem,
      play,
      addToMultiview,
      armMultiviewAdd,
      cancelMultiviewAdd,
      dismountMulti,
      mountMulti,
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
      state.multiMounted,
      state.returnTo,
      state.resumeItem,
      play,
      addToMultiview,
      armMultiviewAdd,
      cancelMultiviewAdd,
      dismountMulti,
      mountMulti,
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
