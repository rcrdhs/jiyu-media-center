/** Curated public playlists auto-imported on first launch (and if missing later). */
export const DEFAULT_PLAYLISTS = [
  {
    id: 'builtin-iptv-org-sports',
    label: 'IPTV-Org Sports',
    url: 'https://iptv-org.github.io/iptv/categories/sports.m3u',
  },
  {
    id: 'builtin-iptv-org-news',
    label: 'IPTV-Org News (Top 100)',
    url: 'https://iptv-org.github.io/iptv/categories/news.m3u',
  },
] as const
