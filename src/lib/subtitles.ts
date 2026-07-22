export interface SubtitleCue {
  start: number
  end: number
  text: string
}

function parseTimestamp(value: string): number {
  const parts = value.trim().split(':')
  if (parts.length === 3) {
    return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number.parseFloat(parts[2])
  }
  if (parts.length === 2) {
    return Number(parts[0]) * 60 + Number.parseFloat(parts[1])
  }
  return Number.parseFloat(parts[0] || '0')
}

/** Parse a WebVTT (or simple SRT-like) document into cues. */
export function parseSubtitleCues(raw: string): SubtitleCue[] {
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
    const match = lines[timeIndex].match(/([\d:.]+)\s*-->\s*([\d:.]+)/)
    if (!match) continue

    const cueText = lines
      .slice(timeIndex + 1)
      .join('\n')
      .replace(/<\/?[^>]+>/g, '')
      .replace(/\{[^}]+\}/g, '')
      .trim()
    if (!cueText) continue

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
    if (time >= cue.start && time <= cue.end) return cue.text
  }
  return ''
}
