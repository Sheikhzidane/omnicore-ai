import type { NextRequest } from 'next/server'
import { requirePlatformAdminReadApi } from '@/lib/auth/api'
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const authz = await requirePlatformAdminReadApi(req)
  if (!authz.ok) return authz.response

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return NextResponse.json({ thought: null, meta: null, intent: null })

  const sb = createClient(url, key)
  const { data } = await sb.from('god_status').select('thought, meta, intent, updated_at').eq('id', 1).single()

  const row = data as { thought?: string; meta?: Record<string, unknown>; intent?: Record<string, unknown>; updated_at?: string } | null
  return NextResponse.json({
    thought:    row?.thought ?? null,
    meta:       row?.meta    ?? null,
    intent:     row?.intent  ?? null,
    updated_at: row?.updated_at ?? null,
  })
}
