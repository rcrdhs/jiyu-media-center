import { useEffect, useState } from 'react'
import {
  createProgressSyncAccount,
  getProgressSyncStatus,
  isProgressSyncConfigured,
  pairProgressSyncDevice,
  progressSyncBaseUrl,
  pullProgressSync,
  setProgressSyncUrlOverride,
  signOutProgressSync,
  subscribeProgressSync,
  type ProgressSyncStatus,
} from '../lib/progressSync'

function formatWhen(ts: number | null): string {
  if (!ts) return '—'
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return '—'
  }
}

export function ProgressSyncSettings() {
  const [status, setStatus] = useState<ProgressSyncStatus>(() => getProgressSyncStatus())
  const [urlDraft, setUrlDraft] = useState(() => progressSyncBaseUrl())
  const [pairDraft, setPairDraft] = useState('')
  const [labelDraft, setLabelDraft] = useState('This device')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => subscribeProgressSync(() => setStatus(getProgressSyncStatus())), [])

  async function run(action: () => Promise<void>, okMsg: string) {
    setBusy(true)
    setErr(null)
    setNote(null)
    try {
      await action()
      setStatus(getProgressSyncStatus())
      setNote(okMsg)
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  function saveUrl() {
    setProgressSyncUrlOverride(urlDraft)
    setStatus(getProgressSyncStatus())
    setNote(
      progressSyncBaseUrl()
        ? 'Sync server saved — Create an account or enter a pair code'
        : 'Sync server cleared',
    )
    setErr(null)
  }

  const configured = isProgressSyncConfigured()

  return (
    <>
      <h3 className="field-label" style={{ marginTop: '1.25rem' }}>
        Continue watching sync{' '}
        <span className="optional-tag">optional · all devices</span>
      </h3>
      <p className="field-hint" style={{ marginTop: '0.25rem', opacity: 0.75 }}>
        Share movie, series, anime, and kids resume progress across phones, PCs, and future
        TV / Apple builds. Same account on every device.
      </p>

      <label className="field-label" htmlFor="progress-sync-url">
        Sync server URL
      </label>
      <input
        id="progress-sync-url"
        className="url-input"
        type="url"
        autoComplete="off"
        spellCheck={false}
        placeholder="https://sync.example.com or http://127.0.0.1:8787"
        value={urlDraft}
        onChange={(event) => setUrlDraft(event.target.value)}
        onBlur={saveUrl}
        aria-label="Progress sync server URL"
      />
      <p className="field-hint" style={{ marginTop: '0.35rem', opacity: 0.75 }}>
        Leave blank until you run a sync host. Local sandbox:{' '}
        <code>npm run test:progress-sync</code> (API on port 8787).
      </p>

      {configured && !status.signedIn ? (
        <>
          <label className="field-label" htmlFor="progress-sync-label">
            Device label
          </label>
          <input
            id="progress-sync-label"
            className="url-input"
            value={labelDraft}
            onChange={(event) => setLabelDraft(event.target.value)}
            aria-label="Device label for sync account"
          />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.5rem' }}>
            <button
              type="button"
              className="primary-btn"
              disabled={busy}
              onClick={() =>
                run(
                  () => createProgressSyncAccount(labelDraft.trim() || 'Jiyu'),
                  'Account created — enter the pair code on your other devices',
                )
              }
            >
              Create sync account
            </button>
          </div>

          <label className="field-label" htmlFor="progress-sync-pair" style={{ marginTop: '0.85rem' }}>
            Pair with another device
          </label>
          <input
            id="progress-sync-pair"
            className="url-input"
            autoComplete="off"
            spellCheck={false}
            placeholder="6-character code"
            value={pairDraft}
            onChange={(event) => setPairDraft(event.target.value.toUpperCase())}
            aria-label="Pair code from another Jiyu device"
          />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.5rem' }}>
            <button
              type="button"
              className="ghost-btn"
              disabled={busy || pairDraft.trim().length < 4}
              onClick={() =>
                run(
                  () => pairProgressSyncDevice(pairDraft.trim()),
                  'Device linked — Continue watching will sync',
                )
              }
            >
              Link this device
            </button>
          </div>
        </>
      ) : null}

      {configured && status.signedIn ? (
        <>
          <p className="field-hint" style={{ marginTop: '0.75rem' }}>
            Signed in{status.label ? ` as ${status.label}` : ''}. Pair code for other devices:{' '}
            <strong style={{ letterSpacing: '0.08em' }}>{status.pairCode || '—'}</strong>
          </p>
          <p className="field-hint" style={{ opacity: 0.75 }}>
            Last pull {formatWhen(status.lastPullAt)} · Last push {formatWhen(status.lastPushAt)}
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.5rem' }}>
            <button
              type="button"
              className="ghost-btn"
              disabled={busy}
              onClick={() => run(() => pullProgressSync({ pushLocal: true }), 'Synced')}
            >
              Sync now
            </button>
            <button
              type="button"
              className="ghost-btn"
              disabled={busy}
              onClick={() => {
                signOutProgressSync()
                setStatus(getProgressSyncStatus())
                setNote('Signed out on this device — local progress kept')
                setErr(null)
              }}
            >
              Sign out
            </button>
          </div>
        </>
      ) : null}

      {status.lastError ? (
        <p className="field-hint" style={{ marginTop: '0.5rem', color: 'var(--danger, #c44)' }}>
          {status.lastError}
        </p>
      ) : null}
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
