import { useEffect, useState } from 'react'
import { pushOverlayDismiss } from '../lib/overlayDismiss'
import { isTizenTv } from '../lib/tvMode'

const SEEN_KEY = 'jiyu.welcome.seen'
export const OPEN_FEATURE_GUIDE_EVENT = 'jiyu:open-feature-guide'

const STEPS = [
  {
    title: 'Welcome to Jiyu',
    body: 'Sports, movies, series, anime, kids, and news in one place. Use the sections menu to jump around.',
  },
  {
    title: 'Shelves update themselves',
    body: 'The first catalog sync can take a while. Titles appear as they arrive — keep browsing. A small progress mark shows if sync continues in the background. Series cards show the network logo (Netflix, HBO, and so on), and Added today, Kids, and Series hide titles Jiyu cannot find a stream for, then check them again later.',
  },
  {
    title: 'Watch & Continue',
    body: 'Open a title to play. Progress saves automatically. Continue watching on Home (and each section) picks up where you left off. Restart clears that for the current episode.',
  },
  {
    title: 'Anime: Sub or Dub',
    body: 'Anime plays in Japanese with subtitles by default. When an episode has an English dub, the player shows a Sub / Dub button: switching keeps your place, and Jiyu remembers your pick for that show. With Dub on, subtitles turn off but stay available from the Subs button. Set your default under Anime audio in Library.',
  },
  {
    title: 'Saved list',
    body: 'Tap the heart on a card or show page to save movies, series, anime, or kids titles. Open Saved from the Home totals panel (next to Added today) to browse and pick what to watch.',
  },
  {
    title: 'Sync across devices',
    body: 'In Library, go to Continue watching sync and tap Create sync account on one device. It shows a single-use pair code (tap New pair code for another). On your other phones or PCs, enter it under Pair with another device and tap Link this device. Resume points then follow you across every linked device.',
  },
  {
    title: 'Library & sources',
    body: 'Library is where you add playlists and web catalogs, set hide-keyword filters, manage sync, choose anime Sub or Dub, and tweak playback prefs.',
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
    title: 'Live streams',
    body: 'Live channels and match streams start on their own — the Unwrapping stream cover stays until the video is actually moving. Pop-ups and ads on stream pages are blocked, and streams keep playing in PiP. Most live streams only keep the last 20-30 seconds or so, so rewinding is limited: a short notice tells you when you reach the limit, and on PC the rewind button grays out.',
  },
  {
    title: 'Install on your TV',
    body: 'Google TV, Android TV, and Fire TV: install the free Downloader app on the TV, then type jiyu.free-river.workers.dev/tv and open the file it downloads. That link always gets the newest TV version, and Jiyu updates itself from the menu after that. The remote works everywhere: arrows to move, OK to select, Back to go back.',
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

  // Samsung Tizen: the remote's Return key closes the guide (Back ladder overlay).
  useEffect(() => {
    if (!open || !isTizenTv()) return
    return pushOverlayDismiss(() => {
      markWelcomeSeen()
      setFromHelp(false)
      setOpen(false)
    })
  }, [open])

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
