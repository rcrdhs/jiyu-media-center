import { useEffect, useRef, useState } from 'react'

/**
 * Click-to-set volume. A controlled range input in Electron resets on click
 * (the thumb snaps back unless you drag), so the pointer position owns the
 * gesture until pointerup.
 */
export function VolumeSlider({
  value,
  max = 100,
  onChange,
  title,
}: {
  value: number
  max?: number
  onChange: (next: number) => void
  title?: string
}) {
  const dragging = useRef(false)
  const [live, setLive] = useState(value)

  useEffect(() => {
    if (!dragging.current) setLive(value)
  }, [value])

  function fromPointer(el: HTMLInputElement, clientX: number) {
    const rect = el.getBoundingClientRect()
    const span = rect.width || 1
    const t = Math.max(0, Math.min(1, (clientX - rect.left) / span))
    return Math.round(t * max)
  }

  function commit(next: number) {
    const clamped = Math.max(0, Math.min(max, Math.round(next)))
    setLive(clamped)
    onChange(clamped)
  }

  return (
    <input
      type="range"
      min={0}
      max={max}
      step={1}
      value={live}
      title={title}
      onPointerDown={(e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return
        e.preventDefault()
        e.stopPropagation()
        dragging.current = true
        e.currentTarget.setPointerCapture(e.pointerId)
        commit(fromPointer(e.currentTarget, e.clientX))
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return
        e.stopPropagation()
        commit(fromPointer(e.currentTarget, e.clientX))
      }}
      onPointerUp={(e) => {
        if (!dragging.current) return
        dragging.current = false
        e.stopPropagation()
        commit(fromPointer(e.currentTarget, e.clientX))
      }}
      onPointerCancel={() => {
        dragging.current = false
      }}
      onChange={(e) => {
        if (dragging.current) return
        commit(Number(e.target.value))
      }}
    />
  )
}
