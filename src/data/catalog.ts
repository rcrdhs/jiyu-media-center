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
  {
    id: 'kids',
    label: 'Kids',
    blurb: 'Curated movies, shows, and live channels for under 13.',
    accent: '#6ec6ff',
  },
]

/** Jamaican local live channels shown on Home → Local channel */
export const LOCAL_CHANNELS: StreamItem[] = [
  {
    id: 'local-tvj',
    title: 'TVJ',
    description: 'Television Jamaica — local live (not always 24/7).',
    category: 'news',
    // Streamlock host is dead. Public HLS from iptv-org Jamaica list (univtec).
    url: 'https://vod2live.univtec.com/manifest/a99a1804-dc83-411f-8c1c-b62f08cdfa59.m3u8',
    poster: 'https://i.imgur.com/R4PoC3L.png',
    // Matches epgshare JM XMLTV (also try IPTV-Org TVJ.jm@SD via matcher aliases).
    tvgId: 'Television.Jamaica.jm',
    tags: ['local', 'jamaica', 'live', 'hls'],
    source: 'Local channel',
    language: 'en',
  },
  {
    id: 'local-cvm',
    title: 'CVM',
    description: 'CVM Television — local live 24×7.',
    category: 'news',
    // No stable public m3u8 (iptv-org empty; moveonjoy dead). Official site embeds
    // Vimeo event 4401057 — desktop resolves a fresh tokenized HLS URL on probe/play.
    url: 'https://vimeo.com/event/4401057',
    poster:
      'https://static.wikia.nocookie.net/logopedia/images/c/c5/CVM_Television_logo_2023.webp/revision/latest/scale-to-width-down/640?cb=20231225060123',
    tvgId: 'CVM.Television.Limited.jm',
    tags: ['local', 'jamaica', 'live', 'hls', 'vimeo'],
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
    tvgId: 'Jamaican.News.Network.jm',
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
    // Prefer working public HLS / YouTube over dead Streamlock mirrors.
    if (/youtube\.com|youtu\.be/i.test(item.url)) n += 12
    if (/vimeo\.com\/event\//i.test(item.url)) n += 18
    if (/vod2live\.univtec\.com|immergo\.tv|akamaized\.net/i.test(item.url)) n += 18
    if (/streamlock\.net|moveonjoy\.com|vimeocdn\.com\/exp=/i.test(item.url)) n -= 20
    if (item.tags?.some((t) => /imported|iptv/i.test(t))) n += 3
    if (/imported|iptv/i.test(item.source ?? '')) n += 2
    if (/720|1080|hd/i.test(item.title)) n += 1
    if (/not\s*24\/?7/i.test(item.title)) n += 1
    return n
  }

  const best = [...matches].sort((a, b) => score(b) - score(a))[0] ?? seed
  // Built-in YouTube / Vimeo seeds win over dead Streamlock / expired CDN mirrors.
  if (
    (/youtube\.com|youtu\.be|vimeo\.com\/event\//i.test(seed.url) &&
      /streamlock\.net|moveonjoy\.com|vimeocdn\.com\/exp=/i.test(best.url)) ||
    (/vimeo\.com\/event\//i.test(seed.url) && /youtube\.com|youtu\.be/i.test(best.url))
  ) {
    return {
      ...seed,
      poster: best.poster || seed.poster,
      tags: [...new Set([...(seed.tags ?? []), 'local'])],
    }
  }
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
    id: 'sports-tnt-uk-youtube',
    title: 'TNT Sports UK — YouTube',
    description:
      'Official free Early Kick-Off (~30 min before Premier League fixtures) when live on YouTube. Full matches need HBO Max.',
    category: 'sports',
    url: 'https://www.youtube.com/@TNTSports/live',
    poster:
      'https://upload.wikimedia.org/wikipedia/en/thumb/b/b5/TNT_Sports_2023_logo.svg/320px-TNT_Sports_2023_logo.svg.png',
    tags: ['tnt', 'premier-league', 'football', 'champions-league', 'youtube', 'uk'],
    source: 'TNT Sports (official)',
    sourceKind: 'builtin',
    language: 'en',
  },
  {
    id: 'sports-tnt-uk-hbomax',
    title: 'TNT Sports UK — HBO Max',
    description:
      'Full Premier League, Champions League, FA Cup, rugby & more — sign in with your HBO Max / TNT Sports subscription.',
    category: 'sports',
    url: 'https://play.hbomax.com/',
    poster:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/1/17/HBO_Max_Logo.svg/320px-HBO_Max_Logo.svg.png',
    tags: ['tnt', 'premier-league', 'football', 'champions-league', 'hbomax', 'uk'],
    source: 'HBO Max (official)',
    sourceKind: 'builtin',
    language: 'en',
  },
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
  // Curated Kids starters (under 13) — public demo streams + shelf seeds.
  {
    id: 'kids-movie-bbb',
    title: 'Big Buck Bunny',
    description: 'Gentle open-movie short for the Kids Movies shelf.',
    category: 'kids',
    url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
    poster:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c5/Big_buck_bunny_poster_big.jpg/440px-Big_buck_bunny_poster_big.jpg',
    tags: ['kids-movies', 'demo', 'mp4'],
    source: 'Kids catalog',
    sourceKind: 'builtin',
    transport: 'direct',
  },
  {
    id: 'kids-movie-sintel',
    title: 'Sintel',
    description: 'Blender Foundation short — Kids Movies sample.',
    category: 'kids',
    url: 'https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8',
    poster:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8f/Sintel_poster.jpg/440px-Sintel_poster.jpg',
    tags: ['kids-movies', 'demo', 'hls'],
    source: 'Kids catalog',
    sourceKind: 'builtin',
    transport: 'direct',
  },
  {
    id: 'kids-movie-elephants',
    title: 'Elephants Dream',
    description: 'Orange open movie — Kids Movies sample.',
    category: 'kids',
    url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
    poster:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e8/Elephants_Dream_s5_both.jpg/480px-Elephants_Dream_s5_both.jpg',
    tags: ['kids-movies', 'demo', 'mp4'],
    source: 'Kids catalog',
    sourceKind: 'builtin',
    transport: 'direct',
  },
]
