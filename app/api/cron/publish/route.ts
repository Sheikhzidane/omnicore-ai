import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { requireCron } from '@/lib/cron'
import { createAdminClient } from '@/lib/supabase/admin'
import { runPublishingCycle } from '@/lib/publishing/worker'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** Vercel Cron → publish due, approved jobs. Idempotent; safe to overlap. */
export async function GET(req: NextRequest) {
  const auth = requireCron(req)
  if (!auth.ok) return auth.response
  try {
    return NextResponse.json(await runPublishingCycle(createAdminClient(), process.env, fetch))
  } catch (e) {
    console.error('[cron/publish]', (e as Error).message)
    return NextResponse.json({ error: 'publishing cycle failed' }, { status: 500 })
  }
}
