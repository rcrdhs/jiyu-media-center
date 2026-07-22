import type { CategoryMeta, StreamItem } from '../types'

export const CATEGORIES: CategoryMeta[] = [
  {
    id: 'sports',
    label: 'Sports',
    blurb: 'Live arenas, highlights, and match feeds.',
    accent: '#3ecf8e',
  },
  {
    id: 'movies',
    label: 'Movies',
    blurb: 'Features and film house streams.',
    accent: '#e8a54b',
  },
  {
    id: 'anime',
    label: 'Anime',
    blurb: 'Series and OVAs you queue up next.',
    accent: '#5b8def',
  },
  {
    id: 'series',
    label: 'TV Series',
    blurb: 'Episodes and binge-ready shows.',
    accent: '#d45d7a',
  },
  {
    id: 'news',
    label: 'News',
    blurb: 'Rolling world and local bulletins.',
    accent: '#c4c9d4',
  },
]

/** Jamaican local live channels shown on Home → Local channel */
export const LOCAL_CHANNELS: StreamItem[] = [
  {
    id: 'local-tvj',
    title: 'TVJ',
    description: 'Television Jamaica — local live channel.',
    category: 'news',
    url: 'https://59d39900b8b2b.streamlock.net/tvj/tvj/playlist.m3u8',
    poster: 'https://images.unsplash.com/photo-1598899134739-24c46f58b8c0?w=640&q=80',
    tags: ['local', 'jamaica', 'live', 'hls'],
    source: 'Local channel',
    language: 'en',
  },
  {
    id: 'local-cvm',
    title: 'CVM',
    description: 'CVM Television — local live channel.',
    category: 'news',
    url: 'https://59d39900b8b2b.streamlock.net/cvm/cvm/playlist.m3u8',
    poster: 'https://images.unsplash.com/photo-1574375927938-d5a98e8ffe85?w=640&q=80',
    tags: ['local', 'jamaica', 'live', 'hls'],
    source: 'Local channel',
    language: 'en',
  },
  {
    id: 'local-nationwide',
    title: 'Nationwide',
    description: 'Nationwide News Network (90FM) — live on YouTube.',
    category: 'news',
    url: 'https://www.youtube.com/@nationwidenewsnetwork/live',
    poster: 'https://images.unsplash.com/photo-1504711435469-e1ffb926aa56?w=640&q=80',
    tags: ['local', 'jamaica', 'live', 'youtube'],
    source: 'Local channel',
    language: 'en',
  },
]

/** Featured live stream on Home → Local channel */
export const TVJ_CHANNEL = LOCAL_CHANNELS[0]

/**
 * Prefer an imported catalog match (e.g. "TVJ (720p)") over the built-in
 * fallback URL when the same local channel exists in the user's playlist.
 */
export function resolveLocalChannels(catalog: StreamItem[]): StreamItem[] {
  return LOCAL_CHANNELS.map((seed) => resolveLocalChannel(seed, catalog))
}

function titleMatchesLocalSeed(title: string, key: string): boolean {
  const t = title.trim().toLowerCase()
  if (t === key) return true
  // "TVJ (720p)", "TVJ [Not 24/7]", "TVJ Live", "CVM Television"
  return new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(t)
}

export function resolveLocalChannel(seed: StreamItem, catalog: StreamItem[]): StreamItem {
  const key = seed.title.trim().toLowerCase()
  const matches = catalog.filter((item) => titleMatchesLocalSeed(item.title, key))

  if (matches.length === 0) return seed

  const score = (item: StreamItem) => {
    let n = 0
    if (item.id !== seed.id) n += 4
    if (item.url !== seed.url) n += 2
    if (/streamlock\.net/i.test(item.url)) n -= 8
    if (item.tags?.some((t) => /imported|iptv/i.test(t))) n += 3
    if (/imported|iptv/i.test(item.source ?? '')) n += 2
    if (/720|1080|hd/i.test(item.title)) n += 1
    if (/not\s*24\/?7/i.test(item.title)) n += 1
    return n
  }

  const best = [...matches].sort((a, b) => score(b) - score(a))[0] ?? seed
  // Keep stream URL/title from the best catalog match, but hide playlist source chrome
  return {
    ...best,
    description: seed.description,
    source: seed.source,
    tags: [...new Set([...(seed.tags ?? []), 'local'])],
  }
}

/** Resolve watch targets so local-tvj / local-cvm open the best live source */
export function resolvePlayableItem(
  item: StreamItem | undefined,
  catalog: StreamItem[],
): StreamItem | undefined {
  if (!item) return undefined
  const seed = LOCAL_CHANNELS.find((local) => local.id === item.id)
  if (!seed) {
    // Also remap if someone opened the dead built-in URL via another path
    if (/streamlock\.net\/(tvj|cvm)\//i.test(item.url)) {
      const key = /\/tvj\//i.test(item.url) ? 'tvj' : 'cvm'
      const seedByUrl = LOCAL_CHANNELS.find((l) => l.title.toLowerCase() === key)
      if (seedByUrl) return resolveLocalChannel(seedByUrl, catalog)
    }
    return item
  }
  return resolveLocalChannel(seed, catalog)
}

/**
 * Built-in shelf samples (public test media) plus local channels.
 * Extend via M3U / IPTV import.
 */
export const BUILTIN_CATALOG: StreamItem[] = [
  ...LOCAL_CHANNELS,
  {
    id: 'movie-bbb',
    title: 'Big Buck Bunny',
    description: 'Open movie project short — soft demo reel for the Movies shelf.',
    category: 'movies',
    url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
    poster: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c5/Big_buck_bunny_poster_big.jpg/440px-Big_buck_bunny_poster_big.jpg',
    tags: ['demo', 'hls'],
    source: 'Mux test stream',
  },
  {
    id: 'movie-sintel',
    title: 'Sintel Trailer',
    description: 'Blender Foundation trailer over HLS for player testing.',
    category: 'movies',
    url: 'https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8',
    poster: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8f/Sintel_poster.jpg/440px-Sintel_poster.jpg',
    tags: ['trailer', 'hls'],
    source: 'Bitmovin demo',
  },
  {
    id: 'series-tears',
    title: 'Tears of Steel',
    description: 'Sci-fi short used here as a series-shelf stand-in stream.',
    category: 'series',
    url: 'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8',
    poster: 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/70/Tears_of_Steel_poster.jpg/440px-Tears_of_Steel_poster.jpg',
    tags: ['demo'],
    source: 'Unified Streaming',
  },
  {
    id: 'anime-elephants',
    title: 'Elephants Dream',
    description: 'Orange open movie — sample anime-shelf card until you wire real sources.',
    category: 'anime',
    url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
    poster: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e8/Elephants_Dream_s5_both.jpg/480px-Elephants_Dream_s5_both.jpg',
    tags: ['mp4', 'demo'],
    source: 'Google sample bucket',
  },
  {
    id: 'sports-forBigger',
    title: 'Arena Warmup Reel',
    description: 'Placeholder sports shelf feed — swap for your league/provider HLS.',
    category: 'sports',
    url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4',
    poster: 'https://images.unsplash.com/photo-1461896833974-bf75c996cb68?w=640&q=80',
    tags: ['demo'],
    source: 'Sample MP4',
  },
  {
    id: 'sports-jump',
    title: 'Court Side Cuts',
    description: 'Second sports placeholder for multi-item browsing.',
    category: 'sports',
    url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4',
    poster: 'https://images.unsplash.com/photo-1517649763962-0c623066027e?w=640&q=80',
    tags: ['demo'],
    source: 'Sample MP4',
  },
  {
    id: 'news-apple',
    title: 'Apple HLS Advanced Stream',
    description: 'Reliable multi-bitrate HLS — useful news-shelf player check.',
    category: 'news',
    url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8',
    poster: 'https://images.unsplash.com/photo-1504711434969-e33886168f5c?w=640&q=80',
    tags: ['hls', 'live-ready'],
    source: 'Apple HLS examples',
  },
]
