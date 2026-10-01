import { useState } from 'react'

const SEEN_KEY = 'jiyu.welcome.seen'

const STEPS = [
  {
    title: 'Welcome to Jiyu',
    body: 'Sports, movies, series, and anime live in one place. Use the sections menu to browse.',
  },
  {
    title: 'The catalog updates itself',
    body: 'The first sync can take a while. Shelves fill as titles arrive, so you can browse while it runs. You can also leave Jiyu and come back — a small progress mark shows while it continues.',
  },
  {
    title: 'Play a title',
    body: 'Open a title to watch. Library is where you add sources and playlists.',
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

/** First launch only. Skip and the last step both dismiss it for good. */
export function WelcomeTour() {
  const [step, setStep] = useState(0)
  const [open, setOpen] = useState(() => !welcomeAlreadySeen())

  if (!open) return null

  const current = STEPS[step] ?? STEPS[0]
  const last = step >= STEPS.length - 1

  function close() {
    markWelcomeSeen()
    setOpen(false)
  }

  return (
    <div className="welcome-tour" role="dialog" aria-modal="true" aria-labelledby="welcome-tour-title">
      <div className="welcome-tour-card">
        <p className="welcome-tour-kicker">
          {step + 1} / {STEPS.length}
        </p>
        <h2 id="welcome-tour-title">{current.title}</h2>
        <p>{current.body}</p>
        <div className="welcome-tour-actions">
          <button type="button" className="welcome-tour-skip" onClick={close}>
            Skip
          </button>
          <button
            type="button"
            className="welcome-tour-next"
            onClick={() => {
              if (last) close()
              else setStep((value) => value + 1)
            }}
          >
            {last ? 'Get started' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  )
}
