const STORAGE_KEY = 'signal.view.v1'

interface SectionViewState {
  query: string
  visible: number
  autoCheck: boolean
  /** Card to scroll back to after opening a title (Back from Show). */
  focusItemId?: string
}

/** Scroll spot inside a full-screen overlay sheet (Added today, Saved, …). */
interface OverlayViewState {
  scrollTop: number
  /** Card last opened from the sheet; fallback anchor when layout differs. */
  focusItemId?: string
}

interface ViewBag {
  scroll: Record<string, number>
  sections: Record<string, SectionViewState>
  overlays?: Record<string, OverlayViewState>
}

function readBag(): ViewBag {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return { scroll: {}, sections: {} }
    const parsed = JSON.parse(raw) as Partial<ViewBag>
    return {
      scroll: parsed.scroll ?? {},
      sections: parsed.sections ?? {},
      overlays: parsed.overlays ?? {},
    }
  } catch {
    return { scroll: {}, sections: {} }
  }
}

function writeBag(bag: ViewBag) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(bag))
  } catch {
    /* ignore quota */
  }
}

export function getMainScroll(key: string): number | undefined {
  const value = readBag().scroll[key]
  return typeof value === 'number' ? value : undefined
}

export function setMainScroll(key: string, scrollTop: number) {
  const bag = readBag()
  bag.scroll[key] = scrollTop
  writeBag(bag)
}

export function getSectionView(sectionId: string): SectionViewState | undefined {
  return readBag().sections[sectionId]
}

export function setSectionView(sectionId: string, state: SectionViewState) {
  const bag = readBag()
  bag.sections[sectionId] = state
  writeBag(bag)
}

/** Remember which shelf card was opened so Back can land on it. */
export function setSectionFocusItem(sectionId: string, itemId: string) {
  const prev = getSectionView(sectionId)
  setSectionView(sectionId, {
    query: prev?.query ?? '',
    visible: prev?.visible ?? 120,
    autoCheck: prev?.autoCheck ?? true,
    focusItemId: itemId,
  })
}

export function clearSectionFocusItem(sectionId: string) {
  const prev = getSectionView(sectionId)
  if (!prev?.focusItemId) return
  setSectionView(sectionId, { ...prev, focusItemId: undefined })
}

export function getOverlayView(key: string): OverlayViewState | undefined {
  return readBag().overlays?.[key]
}

export function setOverlayView(key: string, patch: Partial<OverlayViewState>) {
  const bag = readBag()
  const overlays = bag.overlays ?? {}
  const prev: OverlayViewState = overlays[key] ?? { scrollTop: 0 }
  overlays[key] = { ...prev, ...patch }
  bag.overlays = overlays
  writeBag(bag)
}

export function clearOverlayView(key: string) {
  const bag = readBag()
  if (!bag.overlays?.[key]) return
  delete bag.overlays[key]
  writeBag(bag)
}

export function getMainStage(): HTMLElement | null {
  return document.querySelector('.main-stage')
}
