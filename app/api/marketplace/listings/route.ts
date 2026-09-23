import { requirePlatformAdminApi, requirePlatformAdminReadApi } from '@/lib/auth/api'
import { NextResponse, NextRequest } from 'next/server'
import fs from 'node:fs/promises'
import path from 'node:path'

const REPO_ROOT     = path.resolve(process.cwd())
const MANIFEST_PATH = path.join(REPO_ROOT, 'dist/listings/manifest.json')
const STATUS_PATH   = path.join(REPO_ROOT, 'dist/listings/submissions.json')

type SubmissionStatus = 'not_submitted' | 'submitted' | 'live' | 'rejected'

interface Submission {
  status:      SubmissionStatus
  submittedAt?: string
  liveAt?:     string
  liveUrl?:    string
  notes?:      string
}

interface ManifestListing {
  slug:        string
  name:        string
  submitUrl:   string
  reviewDays:  number
  priceHint:   string
  listingPath: string
  zipPath:     string | null
}

interface Manifest {
  generatedAt: string
  product: { name: string; tagline: string; priceUSD: number }
  listings: ManifestListing[]
}

async function loadManifest(): Promise<Manifest | null> {
  try { return JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf8')) }
  catch { return null }
}

async function loadStatuses(): Promise<Record<string, Submission>> {
  try { return JSON.parse(await fs.readFile(STATUS_PATH, 'utf8')) }
  catch { return {} }
}

async function saveStatuses(statuses: Record<string, Submission>) {
  await fs.mkdir(path.dirname(STATUS_PATH), { recursive: true })
  await fs.writeFile(STATUS_PATH, JSON.stringify(statuses, null, 2))
}

// GET — return manifest + current per-marketplace status
export async function GET(req: NextRequest) {
  const authz = await requirePlatformAdminReadApi(req)
  if (!authz.ok) return authz.response

  const manifest = await loadManifest()
  if (!manifest) {
    return NextResponse.json({
      generated: false,
      message: 'No listings generated yet. Run: node scripts/generate-listings.mjs',
      listings: [],
    })
  }
  const statuses = await loadStatuses()

  const listings = manifest.listings.map(l => ({
    ...l,
    listingContent: null as string | null,
    submission:     statuses[l.slug] ?? { status: 'not_submitted' } as Submission,
  }))

  return NextResponse.json({
    generated: true,
    product:   manifest.product,
    listings,
    generatedAt: manifest.generatedAt,
  })
}

// POST — update submission state, or read listing copy for a specific marketplace
export async function POST(req: NextRequest) {
  const authz = await requirePlatformAdminApi(req, 'ops.marketplace.listings.post')
  if (!authz.ok) return authz.response

  const body = await req.json() as {
    action?: 'mark_submitted' | 'mark_live' | 'mark_rejected' | 'reset' | 'get_copy'
    slug?:   string
    liveUrl?: string
    notes?:  string
  }

  if (!body.slug) return NextResponse.json({ error: 'slug required' }, { status: 400 })

  if (body.action === 'get_copy') {
    const manifest = await loadManifest()
    const entry = manifest?.listings.find(l => l.slug === body.slug)
    if (!entry) return NextResponse.json({ error: 'marketplace not found' }, { status: 404 })
    try {
      const content = await fs.readFile(entry.listingPath, 'utf8')
      return NextResponse.json({ content })
    } catch {
      return NextResponse.json({ error: 'listing file missing' }, { status: 404 })
    }
  }

  const statuses = await loadStatuses()
  const current  = statuses[body.slug] ?? { status: 'not_submitted' } as Submission

  if (body.action === 'mark_submitted') {
    current.status = 'submitted'
    current.submittedAt = new Date().toISOString()
    if (body.notes) current.notes = body.notes
  } else if (body.action === 'mark_live') {
    current.status = 'live'
    current.liveAt = new Date().toISOString()
    if (body.liveUrl) current.liveUrl = body.liveUrl
  } else if (body.action === 'mark_rejected') {
    current.status = 'rejected'
    if (body.notes) current.notes = body.notes
  } else if (body.action === 'reset') {
    delete statuses[body.slug]
    await saveStatuses(statuses)
    return NextResponse.json({ ok: true, submission: { status: 'not_submitted' } })
  } else {
    return NextResponse.json({ error: 'unknown action' }, { status: 400 })
  }

  statuses[body.slug] = current
  await saveStatuses(statuses)
  return NextResponse.json({ ok: true, submission: current })
}
