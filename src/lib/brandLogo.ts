/** Seasonal Christmas branding for the sidebar wordmark (hat on the J). */

/** Nov 1 – Jan 6 local time (inclusive). */
export function isChristmasLogoSeason(now = new Date()): boolean {
  const month = now.getMonth()
  const day = now.getDate()
  if (month === 10) return true // November
  if (month === 11) return true // December
  if (month === 0 && day <= 6) return true // early January
  return false
}

/** Bird mark stays plain year-round — the hat sits on the wordmark instead. */
export function jiyuBrandLogoSrc(_now = new Date()): string {
  return './jiyu-logo.png'
}
