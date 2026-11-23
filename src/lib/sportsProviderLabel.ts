/**
 * Short provider codes on sports cards (mixed into the title):
 * StreamCorner → SC, StreamFree → SF, PPV.st → PPV, Futbol-x → FX, Tim Streams → TS.
 */

const PROVIDER_SUFFIX_RE = /\s*·\s*(SC|SF|PPV|FX|TS)\s*$/i
const PROVIDER_PREFIX_RE = /^\s*(SC|SF|PPV|FX|TS)\s*·\s*/i

export type SportsProviderCode = 'SC' | 'SF' | 'PPV' | 'FX' | 'TS'

/** Strip a trailing/leading SC|SF|PPV|FX marker from a title. */
export function stripSportsProviderLabel(title: string): string {
  return String(title || '')
    .replace(PROVIDER_SUFFIX_RE, '')
    .replace(PROVIDER_PREFIX_RE, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Append ` · SC` (etc.) once — safe for “Home vs Away” parsing (suffix only). */
export function withSportsProviderLabel(title: string, code: SportsProviderCode): string {
  const base = stripSportsProviderLabel(title)
  if (!base) return code
  return `${base} · ${code}`
}

export function sportsProviderCodeFromItem(item: {
  id?: string
  source?: string
  tags?: string[]
}): SportsProviderCode | null {
  if (item.id?.startsWith('streamcorner-') || /^streamcorner$/i.test(String(item.source || ''))) {
    return 'SC'
  }
  if (item.id?.startsWith('streamfree-') || /^streamfree$/i.test(String(item.source || ''))) {
    return 'SF'
  }
  if (item.id?.startsWith('ppvst-') || /^ppv\.?st$/i.test(String(item.source || ''))) {
    return 'PPV'
  }
  if (item.id?.startsWith('futbolx-') || /^futbol-?x$/i.test(String(item.source || ''))) {
    return 'FX'
  }
  if (item.id?.startsWith('timstreams-') || /^tim\s*streams$/i.test(String(item.source || ''))) {
    return 'TS'
  }
  if (item.tags?.some((t) => /^streamcorner$/i.test(String(t || '')))) return 'SC'
  if (item.tags?.some((t) => /^streamfree$/i.test(String(t || '')))) return 'SF'
  if (item.tags?.some((t) => /^ppv\.st$/i.test(String(t || '')))) return 'PPV'
  if (item.tags?.some((t) => /^futbolx$/i.test(String(t || '')))) return 'FX'
  if (item.tags?.some((t) => /^timstreams$/i.test(String(t || '')))) return 'TS'
  return null
}
