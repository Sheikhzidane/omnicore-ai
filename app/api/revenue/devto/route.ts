import type { NextRequest } from 'next/server'
import { requirePlatformAdminReadApi } from '@/lib/auth/api'
import { NextResponse } from 'next/server'

// GET /api/revenue/devto — live stats straight from dev.to API
export async function GET(req: NextRequest) {
  const authz = await requirePlatformAdminReadApi(req)
  if (!authz.ok) return authz.response

  const key = process.env.DEV_TO_API_KEY
  if (!key) {
    return NextResponse.json({ configured: false, articles: [] })
  }

  try {
    const r = await fetch('https://dev.to/api/articles/me/published?per_page=30', {
      headers: { 'api-key': key },
      cache: 'no-store',
    })
    if (!r.ok) {
      return NextResponse.json({ configured: true, error: `dev.to ${r.status}`, articles: [] })
    }

    const arr = await r.json() as Array<{
      id:                      number
      title:                   string
      url:                     string
      page_views_count:        number
      public_reactions_count:  number
      comments_count:          number
      reading_time_minutes:    number
      published_at:            string
      tag_list:                string[]
    }>

    const articles = arr.map(a => ({
      id:            a.id,
      title:         a.title,
      url:           a.url,
      views:         a.page_views_count ?? 0,
      reactions:     a.public_reactions_count ?? 0,
      comments:      a.comments_count ?? 0,
      readingTime:   a.reading_time_minutes ?? 0,
      publishedAt:   a.published_at,
      tags:          a.tag_list ?? [],
    }))

    const totals = {
      views:     articles.reduce((s, a) => s + a.views, 0),
      reactions: articles.reduce((s, a) => s + a.reactions, 0),
      comments:  articles.reduce((s, a) => s + a.comments, 0),
      articles:  articles.length,
      // Dev.to ad revenue share is roughly $1-3 per 1000 views for partner-level accounts.
      // Being conservative here.
      estEarnings: Math.round(articles.reduce((s, a) => s + a.views, 0) / 1000 * 1.5 * 100) / 100,
    }

    return NextResponse.json({
      configured: true,
      articles,
      totals,
    })
  } catch (e) {
    const err = e as { message?: string }
    return NextResponse.json({
      configured: true,
      error: err.message ?? 'fetch failed',
      articles: [],
    }, { status: 200 })
  }
}
