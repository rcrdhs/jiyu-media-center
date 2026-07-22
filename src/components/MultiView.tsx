import { useNavigate } from 'react-router-dom'
import type { StreamItem } from '../types'
import { usePlayback } from '../context/PlaybackContext'
import { Player } from './Player'

interface MultiViewProps {
  slots: StreamItem[]
  primaryId: string | null
  onSpotlight: (id: string) => void
  onRemove: (id: string) => void
  onCloseAll: () => void
  onMinimize?: () => void
}

export function MultiView({
  slots,
  primaryId,
  onSpotlight,
  onRemove,
  onCloseAll,
  onMinimize,
}: MultiViewProps) {
  const navigate = useNavigate()
  const { awaitingAdd, armMultiviewAdd, cancelMultiviewAdd } = usePlayback()
  const count = slots.length
  const gridClass =
    count <= 1 ? 'cols-1' : count === 2 ? 'cols-2' : count === 3 ? 'cols-2' : 'cols-2x2'

  return (
    <div className={`multi-view multi-view-full ${gridClass}`} role="dialog" aria-label="Multi-view">
      <header className="multi-view-bar">
        <button type="button" className="ghost-btn control-btn" onClick={onCloseAll}>
          ← Close all
        </button>
        <div className="multi-view-meta">
          <strong>Multi-view</strong>
          <span>
            {count} stream{count === 1 ? '' : 's'} · click a tile for audio
            {awaitingAdd ? ' · pick another channel to add' : ''}
          </span>
        </div>
        <div className="multi-view-actions">
          {count < 4 && (
            <button
              type="button"
              className={`ghost-btn control-btn${awaitingAdd ? ' is-armed' : ''}`}
              onClick={() => {
                if (awaitingAdd) cancelMultiviewAdd()
                else {
                  armMultiviewAdd()
                  navigate('/')
                }
              }}
            >
              {awaitingAdd ? 'Cancel add' : 'Add stream'}
            </button>
          )}
          {onMinimize && (
            <button
              type="button"
              className="ghost-btn control-btn"
              onClick={onMinimize}
              title="Leave multi-view — keep spotlight stream in PiP"
            >
              PiP
            </button>
          )}
        </div>
      </header>
      <div className={`multi-view-grid ${gridClass}`}>
        {slots.map((slot) => (
          <Player
            key={slot.id}
            item={slot}
            layout="tile"
            isPrimary={slot.id === primaryId}
            onSpotlight={() => onSpotlight(slot.id)}
            onClose={() => onRemove(slot.id)}
          />
        ))}
      </div>
    </div>
  )
}
