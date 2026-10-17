/** Only one Home local-channel preview should have audible audio at a time. */

export const LOCAL_CHANNEL_AUDIO_EVENT = 'jiyu:local-channel-audio'

export function claimLocalChannelAudio(channelId: string) {
  try {
    window.dispatchEvent(
      new CustomEvent(LOCAL_CHANNEL_AUDIO_EVENT, { detail: { id: channelId } }),
    )
  } catch {
    /* ignore */
  }
}

export function releaseLocalChannelAudio(channelId: string) {
  try {
    window.dispatchEvent(
      new CustomEvent(LOCAL_CHANNEL_AUDIO_EVENT, {
        detail: { id: null, from: channelId },
      }),
    )
  } catch {
    /* ignore */
  }
}

export function subscribeLocalChannelAudio(
  onClaim: (channelId: string | null) => void,
): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<{ id?: string | null }>).detail
    onClaim(detail?.id ?? null)
  }
  window.addEventListener(LOCAL_CHANNEL_AUDIO_EVENT, handler)
  return () => window.removeEventListener(LOCAL_CHANNEL_AUDIO_EVENT, handler)
}
