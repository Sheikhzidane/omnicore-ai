import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { requireCron } from '@/lib/cron'
import { createAdminClient } from '@/lib/supabase/admin'
import { runAgentCycle } from '@/lib/agents/runner'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** Vercel Cron → run queued agent tasks. Does nothing unless AGENTS_ENABLED=true. */
export async function GET(req: NextRequest) {
  const auth = requireCron(req)
  if (!auth.ok) return auth.response
  try {
    return NextResponse.json(await runAgentCycle(createAdminClient(), process.env))
  } catch (e) {
    console.error('[cron/agents]', (e as Error).message)
    return NextResponse.json({ error: 'agent cycle failed' }, { status: 500 })
  }
}
