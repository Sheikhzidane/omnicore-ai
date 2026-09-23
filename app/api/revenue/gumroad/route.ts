import { requirePlatformAdminApi, requirePlatformAdminReadApi } from '@/lib/auth/api'
import { NextResponse, NextRequest } from 'next/server'
import fs from 'node:fs/promises'
import path from 'node:path'

const REVENUE_LOG = path.resolve(process.cwd(), 'scripts/revenue-log.json')

interface GumroadProduct {
  name:        string
  tagline:     string
  description: string
  included:    string[]
  price:       number
  generatedAt: string
  publishedUrl?: string
  publishedAt?:  string
}

async function loadRevenue() {
  try {
    return JSON.parse(await fs.readFile(REVENUE_LOG, 'utf8')) as {
      gumroadProducts?: GumroadProduct[]
    }
  } catch {
    return { gumroadProducts: [] }
  }
}

async function saveRevenue(log: object) {
  await fs.writeFile(REVENUE_LOG, JSON.stringify(log, null, 2))
}

// GET /api/revenue/gumroad — list drafted products
export async function GET(req: NextRequest) {
  const authz = await requirePlatformAdminReadApi(req)
  if (!authz.ok) return authz.response

  const log = await loadRevenue()
  return NextResponse.json({
    products: (log.gumroadProducts ?? []).map((p, i) => ({
      index: i,
      ...p,
      isPublished: Boolean(p.publishedUrl),
    })),
  })
}

// POST /api/revenue/gumroad — mark a drafted product as published (records the URL)
export async function POST(req: NextRequest) {
  const authz = await requirePlatformAdminApi(req, 'ops.revenue.gumroad.post')
  if (!authz.ok) return authz.response

  const body = await req.json() as { index?: number; publishedUrl?: string }
  if (typeof body.index !== 'number' || !body.publishedUrl) {
    return NextResponse.json({ error: 'index and publishedUrl are required' }, { status: 400 })
  }
  if (!/^https?:\/\/.+/.test(body.publishedUrl)) {
    return NextResponse.json({ error: 'publishedUrl must be http(s)' }, { status: 400 })
  }

  const log = await loadRevenue() as { gumroadProducts?: GumroadProduct[] }
  if (!log.gumroadProducts || !log.gumroadProducts[body.index]) {
    return NextResponse.json({ error: 'product index not found' }, { status: 404 })
  }

  log.gumroadProducts[body.index].publishedUrl = body.publishedUrl
  log.gumroadProducts[body.index].publishedAt  = new Date().toISOString()

  await saveRevenue(log)
  return NextResponse.json({ ok: true, product: log.gumroadProducts[body.index] })
}
