import { useEffect, useState } from 'react'

const SEEN_KEY = 'jiyu.welcome.seen'
export const OPEN_FEATURE_GUIDE_EVENT = 'jiyu:open-feature-guide'

const STEPS = [
  {
    title: 'Welcome to Jiyu',
    body: 'Sports, movies, series, anime, kids, and news in one place. Use the sections menu to jump around.',
  },
  {
    title: 'Shelves update themselves',
    body: 'The first catalog sync can take a while. Titles appear as they arrive — keep browsing. A small progress mark shows if sync continues in the background.',
  },
  {
    title: 'Watch & Continue',
    body: 'Open a title to play. Progress saves automatically. Continue watching on Home (and each section) picks up where you left off. Restart clears that for the current episode.',
  },
  {
    title: 'Saved list',
    body: 'Tap the heart on a card or show page to save movies, series, anime, or kids titles. Open Saved from the Home totals panel (next to Added today) to browse and pick what to watch.',
  },
  {
    title: 'Sync across devices',
    body: 'In Library, open Continue watching sync. Create an account on one device, then enter the pair code on your other phones or PCs. Resume progress merges across every signed-in device.',
  },
  {
    title: 'Library & sources',
    body: 'Library is where you add playlists and web catalogs, set hide-keyword filters, manage sync, and tweak playback prefs.',
  },
  {
    title: 'Hide titles',
    body: 'On Movies, Series, Anime, and Kids you can blocklist words. Each section has its own list — Kids filters never touch Movies.',
  },
  {
    title: 'Sports & Your teams',
    body: 'Add favorite teams under Sports. Matching live matches and recent replays show on Home under Your teams, and Jiyu can notify you before kickoff.',
  },
  {
    title: 'Player tips',
    body: 'Use the seekbar to jump; Restart starts the episode from the beginning. Minimize to PiP to keep watching while you browse. Multi-view lets you watch more than one stream. Check for updates from the Jiyu menu.',
  },
] as const

function welcomeAlreadySeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1'
  } catch {
    return true
  }
}

function markWelcomeSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1')
  } catch {
    /* ignore */
  }
}

/** Open the in-app feature guide from anywhere (e.g. a ? button). */
export function openFeatureGuide() {
  try {
    window.dispatchEvent(new CustomEvent(OPEN_FEATURE_GUIDE_EVENT))
  } catch {
    /* ignore */
  }
}

/** First-launch tour + on-demand feature explainer. */
export function WelcomeTour() {
  const [step, setStep] = useState(0)
  const [open, setOpen] = useState(() => !welcomeAlreadySeen())
  const [fromHelp, setFromHelp] = useState(false)

  useEffect(() => {
    const onOpen = () => {
      setStep(0)
      setFromHelp(true)
      setOpen(true)
    }
    window.addEventListener(OPEN_FEATURE_GUIDE_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_FEATURE_GUIDE_EVENT, onOpen)
  }, [])

  if (!open) return null

  const current = STEPS[step] ?? STEPS[0]
  const last = step >= STEPS.length - 1

  function close() {
    markWelcomeSeen()
    setFromHelp(false)
    setOpen(false)
  }

  return (
    <div className="welcome-tour" role="dialog" aria-modal="true" aria-labelledby="welcome-tour-title">
      <div className="welcome-tour-card">
        <p className="welcome-tour-kicker">
          {fromHelp ? 'Jiyu guide' : 'Welcome'} · {step + 1} / {STEPS.length}
        </p>
        <h2 id="welcome-tour-title">{current.title}</h2>
        <p>{current.body}</p>
        <div className="welcome-tour-actions">
          <button type="button" className="welcome-tour-skip" onClick={close}>
            {fromHelp ? 'Close' : 'Skip'}
          </button>
          <button
            type="button"
            className="welcome-tour-next"
            onClick={() => {
              if (last) close()
              else setStep((value) => value + 1)
            }}
          >
            {last ? (fromHelp ? 'Done' : 'Get started') : 'Next'}
          </button>
        </div>
      </div>
    </div>
  )
}
