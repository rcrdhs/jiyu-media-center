import { useEffect, useRef, useState } from 'react'

/**
 * Scrubber that owns the pointer gesture (same fix as VolumeSlider).
 * Native range inputs in Electron/Android WebView often snap back on click
 * or ignore slide unless pointer capture drives the value from clientX.
 *
 * Preview lives only inside this component while dragging — the parent should
 * keep passing the live playhead so a dropped gesture can't freeze the bar.
 */
export function SeekSlider({
  value,
  max,
  onCommit,
  onScrub,
  disabled,
  className,
  title,
}: {
  value: number
  max: number
  onCommit: (next: number) => void
  /** Optional live preview while the thumb is moving. */
  onScrub?: (next: number) => void
  disabled?: boolean
  className?: string
  title?: string
}) {
  const dragging = useRef(false)
  const liveRef = useRef(value)
  const ignoreChangeUntilRef = useRef(0)
  const onCommitRef = useRef(onCommit)
  const [live, setLive] = useState(value)
  const maxSafe = Math.max(1, Math.floor(max))
  onCommitRef.current = onCommit

  useEffect(() => {
    if (!dragging.current) {
      liveRef.current = value
      setLive(value)
    }
  }, [value])

  // If Android/WebView drops pointerup, don't leave dragging=true forever
  // (that froze the thumb while the episode kept playing).
  useEffect(() => {
    const releaseDrag = (commitSeek: boolean) => {
      if (!dragging.current) return
      dragging.current = false
      ignoreChangeUntilRef.current = Date.now() + 400
      if (commitSeek) {
        const clamped = Math.max(0, Math.min(maxSafe, Math.round(liveRef.current)))
        liveRef.current = clamped
        setLive(clamped)
        onCommitRef.current(clamped)
      } else {
        liveRef.current = value
        setLive(value)
      }
    }
    const onWinPointerUp = () => releaseDrag(true)
    const onBlur = () => releaseDrag(false)
    window.addEventListener('pointerup', onWinPointerUp)
    window.addEventListener('pointercancel', onWinPointerUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('pointerup', onWinPointerUp)
      window.removeEventListener('pointercancel', onWinPointerUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [value, maxSafe])

  function fromPointer(el: HTMLInputElement, clientX: number) {
    const rect = el.getBoundingClientRect()
    const span = rect.width || 1
    const t = Math.max(0, Math.min(1, (clientX - rect.left) / span))
    return Math.round(t * maxSafe)
  }

  function scrub(next: number) {
    const clamped = Math.max(0, Math.min(maxSafe, Math.round(next)))
    liveRef.current = clamped
    setLive(clamped)
    onScrub?.(clamped)
  }

  function commit(next: number) {
    const clamped = Math.max(0, Math.min(maxSafe, Math.round(next)))
    liveRef.current = clamped
    setLive(clamped)
    // WebKit/Android often fire a synthetic `change` after pointerup — ignore it.
    ignoreChangeUntilRef.current = Date.now() + 400
    onCommit(clamped)
  }

  function endDrag(el: HTMLInputElement, pointerId?: number) {
    if (!dragging.current) return
    dragging.current = false
    try {
      if (pointerId != null && el.hasPointerCapture?.(pointerId)) {
        el.releasePointerCapture(pointerId)
      }
    } catch {
      /* ignore */
    }
    // Commit the last scrubbed value — re-sampling clientX on lift can jump
    // when the finger leaves the bar and was thrashing HLS with a second seek.
    commit(liveRef.current)
  }

  const shown = Math.min(Math.max(0, Math.floor(live)), maxSafe)
  const pct = maxSafe > 0 ? (shown / maxSafe) * 100 : 0

  return (
    <input
      type="range"
      className={className}
      min={0}
      max={maxSafe}
      step={1}
      value={shown}
      disabled={disabled || max <= 0}
      title={title}
      aria-valuemin={0}
      aria-valuemax={maxSafe}
      aria-valuenow={shown}
      style={{ ['--seek-pct' as string]: `${pct}%` }}
      onPointerDown={(e) => {
        if (disabled || max <= 0) return
        if (e.pointerType === 'mouse' && e.button !== 0) return
        e.preventDefault()
        e.stopPropagation()
        dragging.current = true
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          /* older WebViews */
        }
        scrub(fromPointer(e.currentTarget, e.clientX))
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return
        e.stopPropagation()
        scrub(fromPointer(e.currentTarget, e.clientX))
      }}
      onPointerUp={(e) => {
        e.stopPropagation()
        endDrag(e.currentTarget, e.pointerId)
      }}
      onPointerCancel={(e) => {
        endDrag(e.currentTarget, e.pointerId)
      }}
      onLostPointerCapture={() => {
        if (!dragging.current) return
        dragging.current = false
        commit(liveRef.current)
      }}
      onChange={(e) => {
        if (dragging.current) return
        if (Date.now() < ignoreChangeUntilRef.current) return
        commit(Number(e.target.value) || 0)
      }}
      onKeyDown={(e) => e.stopPropagation()}
    />
  )
}
