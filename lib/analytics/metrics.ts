/**
 * Analytics calculations over REAL captured data only (platform APIs or
 * owner imports). Missing values stay null — never zero-filled or estimated —
 * so the UI can say "no data" instead of inventing numbers.
 */

export interface DailyRow {
  day: string
  followers: number | null
  reach: number | null
  impressions: number | null
  views: number | null
  likes: number | null
  comments: number | null
  shares: number | null
  saves: number | null
}

const sumOrNull = (vals: (number | null | undefined)[]) => {
  const present = vals.filter((v): v is number => typeof v === 'number')
  return present.length ? present.reduce((a, b) => a + b, 0) : null
}

export interface Totals { reach: number | null; impressions: number | null; views: number | null; interactions: number | null; days: number }

export function totals(rows: DailyRow[]): Totals {
  const interactions = rows.map(r => sumOrNull([r.likes, r.comments, r.shares, r.saves]))
  return { reach: sumOrNull(rows.map(r => r.reach)), impressions: sumOrNull(rows.map(r => r.impressions)), views: sumOrNull(rows.map(r => r.views)), interactions: sumOrNull(interactions), days: rows.length }
}

/** Interactions ÷ reach (falls back to views, then impressions). Null when there is no denominator. */
export function engagementRate(t: Totals): number | null {
  const base = t.reach ?? t.views ?? t.impressions
  if (t.interactions === null || !base) return null
  return t.interactions / base
}

/** Follower change between the first and last day that actually have a follower count. */
export function followerGrowth(rows: DailyRow[]): { start: number; end: number; change: number; pct: number | null } | null {
  const withCount = rows.filter(r => typeof r.followers === 'number').sort((a, b) => a.day.localeCompare(b.day))
  if (withCount.length < 2) return null
  const start = withCount[0].followers!, end = withCount[withCount.length - 1].followers!
  return { start, end, change: end - start, pct: start > 0 ? (end - start) / start : null }
}

/** Latest snapshot per (key, day) — metrics tables may hold several captures per day. */
export function latestPerDay<T extends { day: string; captured_at: string }>(rows: T[], key: (r: T) => string): T[] {
  const m = new Map<string, T>()
  for (const r of rows) {
    const k = `${key(r)}|${r.day}`
    const cur = m.get(k)
    if (!cur || cur.captured_at < r.captured_at) m.set(k, r)
  }
  return [...m.values()].sort((a, b) => a.day.localeCompare(b.day))
}

export interface ContentPerf { contentItemId: string; title: string; platform: string; views: number | null; interactions: number | null; rate: number | null }

export function rankContent(items: { id: string; title: string; platform: string; rows: DailyRow[] }[]): ContentPerf[] {
  return items.map(i => {
    const t = totals(i.rows)
    return { contentItemId: i.id, title: i.title, platform: i.platform, views: t.views, interactions: t.interactions, rate: engagementRate(t) }
  }).filter(p => p.views !== null || p.interactions !== null)
    .sort((a, b) => (b.interactions ?? -1) - (a.interactions ?? -1))
}

export const formatPct = (v: number | null, digits = 1) => (v === null ? '—' : `${(v * 100).toFixed(digits)}%`)
export const formatCount = (v: number | null) => (v === null ? '—' : new Intl.NumberFormat('en', { notation: v >= 10_000 ? 'compact' : 'standard' }).format(v))
