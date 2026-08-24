/** Detect whether a YouTube @handle/live URL is currently on-air */

export interface LocalYoutubeLiveTarget {
  id: string
  label: string
  detail: string
  url: string
}

/** Shown under Home → Local when the channel is live on YouTube */
export const LOCAL_YOUTUBE_LIVE_TARGETS: LocalYoutubeLiveTarget[] = [
  {
    id: 'tvj-live',
    label: 'TVJ',
    detail: 'Television Jamaica is live on YouTube',
    url: 'https://www.youtube.com/@TelevisionJamaica/live',
  },
  {
    id: 'cvm-live',
    label: 'CVM',
    detail: 'CVM TV News is live on YouTube',
    url: 'https://www.youtube.com/@cvmtvnews/live',
  },
  {
    id: 'nationwide-live',
    label: 'Nationwide',
    detail: 'Nationwide News Network is live on YouTube',
    url: 'https://www.youtube.com/@nationwidenewsnetwork/live',
  },
  {
    id: 'tnt-sports-uk-live',
    label: 'TNT Sports UK',
    detail: 'Official football coverage — free Early Kick-Off on YouTube when live',
    url: 'https://www.youtube.com/@TNTSports/live',
  },
]

function looksLive(html: string): boolean {
  if (!html || html.length < 200) return false
  // Explicit offline markers
  if (/LIVE_STREAM_OFFLINE/i.test(html)) return false
  if (/"isLiveNow"\s*:\s*false/i.test(html) && !/"isLiveNow"\s*:\s*true/i.test(html)) return false
  if (/this channel isn.?t live right now/i.test(html)) return false
  if (/"status"\s*:\s*"LIVE_STREAM_OFFLINE"/i.test(html)) return false

  if (/"isLiveNow"\s*:\s*true/i.test(html)) return true
  if (/"isLiveContent"\s*:\s*true/i.test(html) && /\/watch\?v=/i.test(html)) return true
  if (/hqdefault_live\.jpg/i.test(html) && /"isLiveNow"\s*:\s*true/i.test(html)) return true
  // /live redirected into a watch page with live badge text
  if (/itemprop="isLiveBroadcast"[^>]*content="True"/i.test(html)) return true
  return false
}

async function fetchPageHtml(url: string): Promise<string> {
  if (window.signalDesktop?.fetchPlaylist) {
    const result = await window.signalDesktop.fetchPlaylist(url)
    if (!result.ok) return ''
    return result.content || ''
  }
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    },
  })
  if (!response.ok) return ''
  return await response.text()
}

export async function isYouTubeLiveNow(liveUrl: string): Promise<boolean> {
  try {
    const html = await fetchPageHtml(liveUrl)
    return looksLive(html)
  } catch {
    return false
  }
}

export async function probeLocalYoutubeLive(
  targets: LocalYoutubeLiveTarget[] = LOCAL_YOUTUBE_LIVE_TARGETS,
): Promise<LocalYoutubeLiveTarget[]> {
  const results = await Promise.all(
    targets.map(async (target) => {
      const live = await isYouTubeLiveNow(target.url)
      return live ? target : null
    }),
  )
  return results.filter((t): t is LocalYoutubeLiveTarget => t != null)
}
