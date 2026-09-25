import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { requireCron } from '@/lib/cron'
import { createAdminClient } from '@/lib/supabase/admin'
import { syncContentMetrics } from '@/lib/analytics/sync'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** Vercel Cron → pull post metrics from connected platforms. */
export async function GET(req: NextRequest) {
  const auth = requireCron(req)
  if (!auth.ok) return auth.response
  try {
    return NextResponse.json(await syncContentMetrics(createAdminClient(), process.env, fetch))
  } catch (e) {
    console.error('[cron/metrics]', (e as Error).message)
    return NextResponse.json({ error: 'metrics sync failed' }, { status: 500 })
  }
}
