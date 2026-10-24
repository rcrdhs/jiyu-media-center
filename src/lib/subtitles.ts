export interface SubtitleCue {
  start: number
  end: number
  text: string
}

/** Wyzie free-tier (and similar) injects ad copy as fake cues — never show those. */
export function isJunkSubtitleText(text: string): boolean {
  return /store\.wyzie\.io|wyzie\.io\/|free plan|unlock every source|ad-free subs|ai translation/i.test(
    String(text || ''),
  )
}

function parseTimestamp(value: string): number {
  // SRT uses commas for millis; WebVTT uses dots.
  const normalized = value.trim().replace(',', '.')
  const parts = normalized.split(':')
  if (parts.length === 3) {
    return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number.parseFloat(parts[2])
  }
  if (parts.length === 2) {
    return Number(parts[0]) * 60 + Number.parseFloat(parts[1])
  }
  return Number.parseFloat(parts[0] || '0')
}

/**
 * Bilibili subtitle JSON (bilibili.tv `.json` tracks and bilibili.com CC / AI tracks):
 * `{ body: [{ from, to, content }] }` with times in seconds. Returns null when `raw` is not
 * that shape so callers fall through to the text parsers.
 */
export function parseBilibiliJsonCues(raw: string): SubtitleCue[] | null {
  const text = String(raw || '').replace(/^\uFEFF/, '').trim()
  if (!text.startsWith('{') || !text.includes('"body"')) return null
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  const body = (data as { body?: unknown })?.body
  if (!Array.isArray(body)) return null
  const cues: SubtitleCue[] = []
  for (const row of body as Array<{ from?: unknown; to?: unknown; content?: unknown }>) {
    const start = Number(row?.from)
    const end = Number(row?.to)
    const cueText = String(row?.content ?? '')
      .replace(/\r/g, '')
      .replace(/<\/?[^>]+>/g, '')
      .trim()
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !cueText) continue
    if (isJunkSubtitleText(cueText)) continue
    cues.push({ start, end, text: cueText })
  }
  cues.sort((a, b) => a.start - b.start || a.end - b.end)
  return cues
}

/** ASS / SSA `[Events]` Dialogue lines → cues (styling tags dropped, \N → newline). */
export function parseAssCues(raw: string): SubtitleCue[] | null {
  const text = String(raw || '').replace(/^\uFEFF/, '').replace(/\r/g, '')
  if (!/^\s*\[Script Info\]/im.test(text) && !/^Dialogue:/m.test(text)) return null
  let fields = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text']
  const cues: SubtitleCue[] = []
  const assTime = (v: string) => {
    const m = /^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(v.trim())
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number.parseFloat(m[3]) : NaN
  }
  for (const line of text.split('\n')) {
    const fmt = /^Format:\s*(.+)$/i.exec(line)
    if (fmt && /\btext\b/i.test(fmt[1])) {
      fields = fmt[1].split(',').map((f) => f.trim().toLowerCase())
      continue
    }
    const dlg = /^Dialogue:\s*(.*)$/i.exec(line)
    if (!dlg) continue
    const parts = dlg[1].split(',')
    if (parts.length < fields.length) continue
    const head = parts.slice(0, fields.length - 1)
    const body = parts.slice(fields.length - 1).join(',')
    const start = assTime(head[fields.indexOf('start')] || '')
    const end = assTime(head[fields.indexOf('end')] || '')
    const cueText = body
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\[Nn]/g, '\n')
      .replace(/\\h/g, ' ')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join('\n')
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !cueText) continue
    if (isJunkSubtitleText(cueText)) continue
    cues.push({ start, end, text: cueText })
  }
  cues.sort((a, b) => a.start - b.start || a.end - b.end)
  return cues
}

/** Parse a WebVTT / SRT document (or Bilibili JSON / ASS track) into cues. */
export function parseSubtitleCues(raw: string): SubtitleCue[] {
  const json = parseBilibiliJsonCues(raw)
  if (json) return json
  const ass = parseAssCues(raw)
  if (ass && ass.length > 0) return ass
  const text = raw.replace(/^\uFEFF/, '').replace(/\r/g, '')
  const body = text.replace(/^WEBVTT[^\n]*\n+/i, '')
  const blocks = body.split(/\n\s*\n/)
  const cues: SubtitleCue[] = []

  for (const block of blocks) {
    const lines = block
      .trim()
      .split('\n')
      .filter((line) => line.trim().length > 0)
    if (lines.length < 2) continue

    let timeIndex = lines.findIndex((line) => line.includes('-->'))
    if (timeIndex < 0) continue
    const match = lines[timeIndex].match(/([\d:.,]+)\s*-->\s*([\d:.,]+)/)
    if (!match) continue

    const cueText = lines
      .slice(timeIndex + 1)
      .join('\n')
      .replace(/<\/?[^>]+>/g, '')
      .replace(/\{[^}]+\}/g, '')
      .trim()
    if (!cueText || isJunkSubtitleText(cueText)) continue

    cues.push({
      start: parseTimestamp(match[1]),
      end: parseTimestamp(match[2]),
      text: cueText,
    })
  }

  return cues
}

export function activeSubtitleText(cues: SubtitleCue[], time: number): string {
  for (let i = cues.length - 1; i >= 0; i -= 1) {
    const cue = cues[i]
    if (time >= cue.start && time <= cue.end) {
      return isJunkSubtitleText(cue.text) ? '' : cue.text
    }
  }
  return ''
}
