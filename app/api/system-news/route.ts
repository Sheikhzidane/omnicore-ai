import type { NextRequest } from 'next/server'
import { requirePlatformAdminReadApi } from '@/lib/auth/api'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const revalidate = 300  // 5 min edge-cache is plenty for status feeds

const FEEDS = [
  { source: 'anthropic', url: 'https://status.anthropic.com/history.rss' },
  { source: 'vercel',    url: 'https://www.vercel-status.com/history.rss' },
  { source: 'github',    url: 'https://www.githubstatus.com/history.rss' },
]

interface NewsItem { source: string; title: string; link: string; pubDate: string | null }

/**
 * Lightweight RSS aggregator so the dashboard can warn the user when
 * something upstream is breaking before it affects our runs. Parses
 * the minimum — title/link/pubDate only.
 */
export async function GET(req: NextRequest) {
  const authz = await requirePlatformAdminReadApi(req)
  if (!authz.ok) return authz.response

  const all: NewsItem[] = []
  const results = await Promise.allSettled(FEEDS.map(async f => {
    const res = await fetch(f.url, { next: { revalidate: 300 } })
    if (!res.ok) return []
    const xml = await res.text()
    return parseItems(xml, f.source)
  }))
  for (const r of results) if (r.status === 'fulfilled') all.push(...r.value)
  all.sort((a, b) => (b.pubDate ?? '').localeCompare(a.pubDate ?? ''))
  return NextResponse.json({ items: all.slice(0, 8) })
}

function parseItems(xml: string, source: string): NewsItem[] {
  const items: NewsItem[] = []
  const itemRe   = /<item[\s\S]*?>[\s\S]*?<\/item>/g
  const titleRe  = /<title>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/title>/
  const linkRe   = /<link>\s*([\s\S]*?)\s*<\/link>/
  const dateRe   = /<pubDate>\s*([\s\S]*?)\s*<\/pubDate>/

  for (const chunk of xml.match(itemRe) ?? []) {
    const title   = chunk.match(titleRe)?.[1]?.trim()
    const link    = chunk.match(linkRe)?.[1]?.trim()
    const pubRaw  = chunk.match(dateRe)?.[1]?.trim() ?? null
    if (!title) continue
    const pubDate = pubRaw ? new Date(pubRaw).toISOString() : null
    items.push({ source, title: title.slice(0, 140), link: link ?? '', pubDate })
    if (items.length >= 4) break  // top 4 per source is more than enough
  }
  return items
}
