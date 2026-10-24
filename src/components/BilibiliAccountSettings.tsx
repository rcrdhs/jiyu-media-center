import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  biliTvSessionSupported,
  cancelBiliTvSignIn,
  getBiliTvSessionStatus,
  onBiliTvSessionChange,
  signOutBiliTv,
  startBiliTvSignIn,
  type BiliTvSessionStatus,
} from '../lib/biliSession'

function formatWhen(ms: number): string {
  if (!ms) return '—'
  try {
    return new Date(ms).toLocaleString()
  } catch {
    return '—'
  }
}

/**
 * Settings: optional bilibili.tv account for this device only. Signing in unlocks the
 * qualities your account can watch (720P / 1080P; Premium titles with your own Premium)
 * in Jiyu's player. The cookie stays on this device (encrypted where the OS allows) and
 * is only sent to bilibili.tv's playurl / subtitle APIs.
 */
export function BilibiliAccountSettings() {
  const navigate = useNavigate()
  const location = useLocation()
  const supported = biliTvSessionSupported()
  const [status, setStatus] = useState<BiliTvSessionStatus>({ signedIn: false, encrypted: false, savedAt: 0 })
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!supported) return
    let alive = true
    void getBiliTvSessionStatus().then((s) => {
      if (alive) setStatus(s)
    })
    const off = onBiliTvSessionChange((s) => {
      if (!alive) return
      setStatus(s)
      if (s.signedIn) {
        setNote('Signed in to Bilibili on this device')
        setErr(null)
      }
    })
    return () => {
      alive = false
      off()
    }
  }, [supported])

  const signIn = async () => {
    setBusy(true)
    setErr(null)
    setNote(null)
    try {
      const r = await startBiliTvSignIn()
      setStatus(r.status)
      if (r.openUrl) {
        setNote('Tap “Log in” on bilibili.tv and sign in — Jiyu saves the session when it sees your account.')
        navigate(`/web?url=${encodeURIComponent(r.openUrl)}`, {
          state: { from: `${location.pathname}${location.search}` },
        })
      } else if (r.status.signedIn) {
        setNote('Signed in to Bilibili on this device')
      } else if (r.cancelled) {
        setNote('Sign-in cancelled')
      } else if (r.error) {
        setErr(r.error)
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h3 className="field-label" style={{ marginTop: '1.25rem' }}>
        Bilibili account <span className="optional-tag">optional · this device</span>
      </h3>
      <p className="field-hint" style={{ marginTop: '0.25rem', opacity: 0.75 }}>
        Without an account bilibili.tv episodes play in Jiyu up to 480P. Sign in for the
        qualities your account can watch (and Premium titles if you have Premium). The session
        stays on this device and is only sent to bilibili.tv’s video and subtitle APIs.
      </p>

      {!supported ? (
        <p className="field-hint" style={{ opacity: 0.75 }}>
          Not available in this build yet — restart / update the app.
        </p>
      ) : status.signedIn ? (
        <>
          <p className="field-hint" style={{ marginTop: '0.5rem' }}>
            Signed in to bilibili.tv · since {formatWhen(status.savedAt)}
            {status.encrypted ? '' : ' · stored unencrypted (no OS keystore)'}
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.5rem' }}>
            <button
              type="button"
              className="ghost-btn"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  setStatus(await signOutBiliTv())
                  setNote('Signed out of Bilibili on this device')
                  setErr(null)
                } finally {
                  setBusy(false)
                }
              }}
            >
              Sign out
            </button>
          </div>
        </>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.5rem' }}>
          <button type="button" className="primary-btn" disabled={busy} onClick={() => void signIn()}>
            Sign in to Bilibili
          </button>
          {status.capturing ? (
            <button
              type="button"
              className="ghost-btn"
              onClick={async () => {
                await cancelBiliTvSignIn()
                setStatus(await getBiliTvSessionStatus())
                setNote('Sign-in cancelled')
              }}
            >
              Cancel
            </button>
          ) : null}
        </div>
      )}

      {err ? (
        <p className="field-hint" style={{ marginTop: '0.5rem', color: 'var(--danger, #c44)' }}>
          {err}
        </p>
      ) : null}
      {note ? (
        <p className="field-hint" style={{ marginTop: '0.5rem', opacity: 0.85 }}>
          {note}
        </p>
      ) : null}
    </>
  )
}
