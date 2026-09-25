/**
 * Timezone-correct scheduling without a date library. Posts are scheduled in
 * the character's/owner's IANA timezone and stored as UTC instants.
 */

export function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true } catch { return false }
}

/** Offset (ms) of `tz` from UTC at the given instant. */
function offsetAt(tz: string, instant: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instant))
  const get = (t: string) => Number(parts.find(p => p.type === t)!.value)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return asUtc - Math.floor(instant / 1000) * 1000
}

/**
 * Converts a wall-clock time in `tz` ("2026-10-01", "09:30") to a UTC ISO
 * string. Nonexistent local times (DST spring-forward gap) move forward to the
 * first valid instant; ambiguous ones (fall-back) resolve to the earlier one.
 */
export function zonedToUtc(date: string, time: string, tz: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) throw new Error('expected YYYY-MM-DD and HH:MM')
  if (!isValidTimeZone(tz)) throw new Error(`unknown timezone ${tz}`)
  const [y, mo, d] = date.split('-').map(Number), [h, mi] = time.split(':').map(Number)
  const wall = Date.UTC(y, mo - 1, d, h, mi)
  // Two passes handle offsets that change between the guess and the answer.
  const candidates = [wall - offsetAt(tz, wall - 12 * 3600_000), wall - offsetAt(tz, wall + 12 * 3600_000)]
  const exact = candidates.filter(c => c + offsetAt(tz, c) === wall).sort((a, b) => a - b)
  if (exact.length) return new Date(exact[0]).toISOString()
  // In a DST gap: use the post-transition offset (moves the time forward).
  return new Date(Math.max(...candidates)).toISOString()
}

/** Formats a UTC instant as local wall-clock time in `tz` for display. */
export function formatInZone(iso: string, tz: string, locale = 'en-GB'): string {
  return new Intl.DateTimeFormat(locale, { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso))
}

export const publishIdempotencyKey = (approvalId: string, socialAccountId: string) => `publish:${approvalId}:${socialAccountId}`
