const STORAGE_KEY = 'signal.view.v1'

interface SectionViewState {
  query: string
  visible: number
  autoCheck: boolean
}

interface ViewBag {
  scroll: Record<string, number>
  sections: Record<string, SectionViewState>
}

function readBag(): ViewBag {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return { scroll: {}, sections: {} }
    const parsed = JSON.parse(raw) as Partial<ViewBag>
    return {
      scroll: parsed.scroll ?? {},
      sections: parsed.sections ?? {},
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

export function getMainStage(): HTMLElement | null {
  return document.querySelector('.main-stage')
}
