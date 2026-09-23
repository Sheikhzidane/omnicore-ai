import type { NextRequest } from 'next/server'
import { requirePlatformAdminApi, requirePlatformAdminReadApi } from '@/lib/auth/api'
import { NextResponse } from 'next/server'
import fs from 'node:fs/promises'
import path from 'node:path'

const WISDOM_PATH  = path.resolve(process.cwd(), 'scripts/god-wisdom.json')
const REVENUE_PATH = path.resolve(process.cwd(), 'scripts/revenue-log.json')

interface Competitor {
  name:          string
  url?:          string
  price?:        string
  positioning?:  string
  key_features?: string[]
  differentiators?: string
}

interface ResearchFinding {
  at:                 string
  cycle:              number
  query?:             string
  competitors?:       Competitor[]
  pricing_insights?:  string
  positioning_gaps?:  string
  suggested_changes?: string[]
}

interface FunnelFinding {
  summary: Record<string, unknown>
  diagnosis: {
    weakest_step: string
    diagnosis:    string
    fix:          string
    category:     string
    priority:     string
  } | null
}

interface ListingProposal {
  at:               string
  cycle:            number
  applied:          boolean
  rationale?:       string
  new_title?:       string
  new_tagline?:     string
  new_description?: string
  confidence?:      string
  priorTitle?:      string
  priorTagline?:    string
  priorDescription?:string
}

async function safeRead<T>(p: string, fallback: T): Promise<T> {
  try { return JSON.parse(await fs.readFile(p, 'utf8')) as T } catch { return fallback }
}

export async function GET(req: NextRequest) {
  const authz = await requirePlatformAdminReadApi(req)
  if (!authz.ok) return authz.response

  const wisdom  = await safeRead<{ marketResearch?: ResearchFinding[]; funnelFindings?: FunnelFinding[]; cycles?: number }>(WISDOM_PATH, {})
  const revenue = await safeRead<{ pendingListingUpdates?: ListingProposal[] }>(REVENUE_PATH, {})

  return NextResponse.json({
    cycle:            wisdom.cycles ?? 0,
    latestMarket:     (wisdom.marketResearch ?? []).slice(-1)[0] ?? null,
    allMarket:        (wisdom.marketResearch ?? []).slice(-3),
    latestFunnel:     (wisdom.funnelFindings ?? []).slice(-1)[0] ?? null,
    allFunnel:        (wisdom.funnelFindings ?? []).slice(-3),
    pendingListing:   (revenue.pendingListingUpdates ?? []).filter(p => !p.applied),
    appliedListings:  (revenue.pendingListingUpdates ?? []).filter(p =>  p.applied).slice(-3),
  })
}

// PATCH /api/market-intel — mark a listing proposal as applied
export async function PATCH(req: NextRequest) {
  const authz = await requirePlatformAdminApi(req, 'ops.market-intel.patch')
  if (!authz.ok) return authz.response

  const body = await req.json().catch(() => null) as { cycle?: number; applied?: boolean } | null
  if (!body?.cycle) {
    return NextResponse.json({ error: 'cycle is required' }, { status: 400 })
  }

  const revenue = await safeRead<{ pendingListingUpdates?: ListingProposal[] }>(REVENUE_PATH, {})
  const updates = revenue.pendingListingUpdates ?? []
  const match = updates.find(u => u.cycle === body.cycle)
  if (!match) return NextResponse.json({ error: 'proposal not found' }, { status: 404 })

  match.applied = body.applied !== false

  await fs.writeFile(REVENUE_PATH, JSON.stringify({ ...revenue, pendingListingUpdates: updates }, null, 2))
  return NextResponse.json({ ok: true, applied: match.applied })
}
