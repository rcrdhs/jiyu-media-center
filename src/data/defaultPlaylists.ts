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
  /** Ships x-tvg-url + matching tvg-ids so Guide has schedules out of the box. */
  {
    id: 'builtin-mjh-free-tv',
    label: 'Free TV (with guide)',
    url: 'https://i.mjh.nz/all/raw-tv.m3u8',
  },
  {
    id: 'builtin-iptv-org-kids',
    label: 'IPTV-Org Kids',
    url: 'https://iptv-org.github.io/iptv/categories/kids.m3u',
  },
] as const
