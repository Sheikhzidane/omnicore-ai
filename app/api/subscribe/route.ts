import { requirePlatformAdminReadApi } from '@/lib/auth/api'
import { NextRequest, NextResponse } from 'next/server'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import fs from 'node:fs/promises'
import path from 'node:path'

const STORE_PATH = path.resolve(process.cwd(), 'scripts/subscribers.json')

interface Subscriber {
  email:      string
  source:     string
  referrer?:  string
  createdAt:  string
  confirmed:  boolean
}

// ── JSON fallback for local/dev when Supabase isn't reachable ───────────────
async function loadJson(): Promise<{ subscribers: Subscriber[] }> {
  try { return JSON.parse(await fs.readFile(STORE_PATH, 'utf8')) }
  catch { return { subscribers: [] } }
}
async function saveJson(store: { subscribers: Subscriber[] }) {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true })
  await fs.writeFile(STORE_PATH, JSON.stringify(store, null, 2))
}

// ── Supabase path — preferred in production so serverless writes persist ────
// Public signups are written server-side with the service role after
// validation + rate limiting (there is no anonymous insert policy).
async function supabaseAdd(email: string, source: string, referrer?: string) {
  const supabase = createAdminClient()
  const { error } = await supabase
    .from('subscribers')
    .insert({ email, source, referrer: referrer ?? null })
  if (error) {
    // Postgres unique_violation
    if (error.code === '23505') return { already: true }
    throw new Error(error.message)
  }
  return { created: true }
}

async function supabaseStats() {
  const supabase = await createServerClient()
  const { data, error } = await supabase
    .from('subscribers')
    .select('email, source, referrer, created_at')
    .order('created_at', { ascending: false })
    .limit(500)
  if (error) throw new Error(error.message)
  return (data ?? []).map(r => {
    const row = r as { email: string; source: string; referrer: string | null; created_at: string }
    return {
      email:     row.email,
      source:    row.source,
      referrer:  row.referrer ?? undefined,
      createdAt: row.created_at,
      confirmed: true,
    }
  })
}

async function supabaseExists(): Promise<boolean> {
  try {
    const supabase = createAdminClient()
    const { error } = await supabase.from('subscribers').select('email').limit(1)
    if (!error) return true
    // "relation does not exist" means migration not applied — fall back to JSON
    return false
  } catch { return false }
}

const SUBSCRIBED = "Thanks — you're on the list."

function validEmail(e: string): boolean {
  return typeof e === 'string'
    && e.length >= 6
    && e.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)
}

// POST /api/subscribe — add a subscriber
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as {
    email?:    string
    source?:   string
    referrer?: string
  }

  const email    = (body.email ?? '').trim().toLowerCase()
  const source   = (body.source ?? 'unknown').slice(0, 80)
  const referrer = body.referrer?.slice(0, 200)

  if (!validEmail(email)) {
    return NextResponse.json({ error: 'Invalid email address' }, { status: 400 })
  }

  // Try Supabase first; fall back to JSON if the table doesn't exist yet
  const useSupabase = await supabaseExists()

  if (useSupabase) {
    try {
      await supabaseAdd(email, source, referrer)
      // Identical response whether or not the email already existed, so the
      // endpoint can't be used to test who is subscribed.
      return NextResponse.json({ ok: true, message: SUBSCRIBED })
    } catch (e) {
      // Supabase failed unexpectedly — fall through to JSON
      console.error('[subscribe] Supabase insert failed:', (e as Error).message)
    }
  }

  // JSON fallback path
  const store = await loadJson()
  if (store.subscribers.find(s => s.email === email)) {
    return NextResponse.json({ ok: true, message: SUBSCRIBED })
  }
  store.subscribers.push({
    email, source, referrer,
    createdAt: new Date().toISOString(),
    confirmed: false,
  })
  await saveJson(store)
  return NextResponse.json({ ok: true, message: SUBSCRIBED })
}

// GET /api/subscribe — stats + recent list (for dashboard)
export async function GET(req: NextRequest) {
  const authz = await requirePlatformAdminReadApi(req)
  if (!authz.ok) return authz.response

  const format = req.nextUrl.searchParams.get('format')

  // Unified read: try Supabase, fall back to JSON
  let all: Subscriber[]
  if (await supabaseExists()) {
    try {
      all = await supabaseStats()
    } catch (e) {
      console.error('[subscribe] Supabase read failed:', (e as Error).message)
      all = (await loadJson()).subscribers
    }
  } else {
    all = (await loadJson()).subscribers
  }

  if (format === 'csv') {
    const header = 'email,source,referrer,createdAt'
    const rows = all.map(s =>
      [s.email, s.source, s.referrer ?? '', s.createdAt].map(csvEscape).join(',')
    )
    return new NextResponse([header, ...rows].join('\n'), {
      status: 200,
      headers: {
        'content-type':        'text/csv',
        'content-disposition': `attachment; filename="subscribers-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    })
  }

  const total  = all.length
  const recent = all.slice(0, 20)
  const today  = new Date().toISOString().slice(0, 10)
  const last7  = Date.now() - 7 * 86_400_000
  const todayCount = all.filter(s => s.createdAt.startsWith(today)).length
  const weekCount  = all.filter(s => new Date(s.createdAt).getTime() >= last7).length

  const bySource: Record<string, number> = {}
  for (const s of all) bySource[s.source] = (bySource[s.source] ?? 0) + 1

  return NextResponse.json({
    total,
    today:  todayCount,
    week:   weekCount,
    recent,
    bySource,
  })
}

function csvEscape(v: string): string {
  if (v.includes(',') || v.includes('"') || v.includes('\n')) {
    return `"${v.replace(/"/g, '""')}"`
  }
  return v
}
