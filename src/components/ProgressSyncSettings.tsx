import { useCallback, useEffect, useState } from 'react'
import {
  createProgressSyncAccount,
  defaultProgressSyncUrl,
  getProgressSyncStatus,
  isProgressSyncConfigured,
  listProgressSyncDevices,
  newProgressSyncPairCode,
  pairProgressSyncDevice,
  progressSyncBaseUrl,
  removeProgressSyncDevice,
  setProgressSyncUrlOverride,
  signOutProgressSync,
  subscribeProgressSync,
  syncProgressNow,
  type ProgressSyncDevice,
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

  const [devices, setDevices] = useState<ProgressSyncDevice[] | null>(null)
  const [, setTick] = useState(0)

  useEffect(() => subscribeProgressSync(() => setStatus(getProgressSyncStatus())), [])

  // Re-render once a minute so the pair-code countdown / expiry stays honest.
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 30_000)
    return () => window.clearInterval(id)
  }, [])

  const refreshDevices = useCallback(async () => {
    if (!getProgressSyncStatus().signedIn) {
      setDevices(null)
      return
    }
    try {
      setDevices(await listProgressSyncDevices())
    } catch {
      setDevices(null)
    }
  }, [])

  useEffect(() => {
    void refreshDevices()
  }, [status.signedIn, refreshDevices])

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
    try {
      setProgressSyncUrlOverride(urlDraft)
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
      setNote(null)
      return
    }
    setUrlDraft(progressSyncBaseUrl())
    setStatus(getProgressSyncStatus())
    setNote(
      progressSyncBaseUrl()
        ? 'Sync server saved — Create an account or enter a pair code'
        : 'Sync server cleared',
    )
    setErr(null)
  }

  function removeDevice(device: ProgressSyncDevice) {
    const prompt = device.current
      ? 'Remove this device from sync? It signs out here; local progress is kept.'
      : `Remove "${device.label}" from sync? It will be signed out the next time it connects.`
    if (!window.confirm(prompt)) return
    void run(async () => {
      await removeProgressSyncDevice(device.id)
      await refreshDevices()
    }, device.current ? 'This device was removed from sync' : `Removed ${device.label}`)
  }

  const configured = isProgressSyncConfigured()
  const pairMinutesLeft = status.pairCodeExpiresAt
    ? Math.max(0, Math.ceil((status.pairCodeExpiresAt - Date.now()) / 60_000))
    : 0

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
        placeholder={defaultProgressSyncUrl() || 'https://sync.example.com'}
        value={urlDraft}
        onChange={(event) => setUrlDraft(event.target.value)}
        onBlur={saveUrl}
        aria-label="Progress sync server URL"
      />
      <p className="field-hint" style={{ marginTop: '0.35rem', opacity: 0.75 }}>
        Leave blank to use the built-in Jiyu sync server. Only https:// hosts are allowed
        (http://127.0.0.1 for the local sandbox).
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
            placeholder="8-character code"
            value={pairDraft}
            onChange={(event) => setPairDraft(event.target.value.toUpperCase())}
            aria-label="Pair code from another Jiyu device"
          />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.5rem' }}>
            <button
              type="button"
              className="ghost-btn"
              disabled={busy || pairDraft.replace(/[^A-Za-z0-9]/g, '').length < 8}
              onClick={() =>
                run(
                  () => pairProgressSyncDevice(pairDraft.trim(), labelDraft.trim() || 'Jiyu'),
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
            Signed in{status.label ? ` as ${status.label}` : ''}.{' '}
            {status.pairCode ? (
              <>
                Pair code for another device:{' '}
                <strong style={{ letterSpacing: '0.08em' }}>{status.pairCode}</strong> (single use,
                expires in {pairMinutesLeft} min)
              </>
            ) : (
              'Get a pair code to link another device.'
            )}
          </p>
          <p className="field-hint" style={{ opacity: 0.75 }}>
            Last pull {formatWhen(status.lastPullAt)} · Last push {formatWhen(status.lastPushAt)}
            {status.pending > 0 ? ` · ${status.pending} waiting to upload` : ''}
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.5rem' }}>
            <button
              type="button"
              className="ghost-btn"
              disabled={busy}
              onClick={() => run(() => syncProgressNow(), 'Synced')}
            >
              Sync now
            </button>
            <button
              type="button"
              className="ghost-btn"
              disabled={busy}
              onClick={() => run(() => newProgressSyncPairCode(), 'New pair code ready (10 minutes)')}
            >
              New pair code
            </button>
            <button
              type="button"
              className="ghost-btn"
              disabled={busy}
              onClick={() =>
                run(() => signOutProgressSync(), 'Signed out on this device — local progress kept')
              }
            >
              Sign out
            </button>
          </div>

          <h4 className="field-label" style={{ marginTop: '0.85rem' }}>
            Linked devices
          </h4>
          {devices === null ? (
            <p className="field-hint" style={{ opacity: 0.75 }}>
              Device list unavailable offline.
            </p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: '0.25rem 0 0' }}>
              {devices.map((device) => (
                <li
                  key={device.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '0.5rem',
                    padding: '0.3rem 0',
                  }}
                >
                  <span className="field-hint" style={{ margin: 0 }}>
                    <strong>{device.label || 'Device'}</strong>
                    {device.current ? ' (this device)' : ''} · last seen{' '}
                    {formatWhen(device.lastSeenAt)}
                  </span>
                  <button
                    type="button"
                    className="ghost-btn"
                    disabled={busy}
                    onClick={() => removeDevice(device)}
                    aria-label={`Remove ${device.label || 'device'} from sync`}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
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
