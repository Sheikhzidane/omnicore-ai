import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabasePublicEnv } from '@/lib/supabase/env'
import { recordAudit } from '@/lib/audit'

/** Signs out (POST only — a GET can be triggered cross-site by an <img> tag). */
export async function POST(req: NextRequest) {
  if (supabasePublicEnv()) {
    const supabase = await createClient()
    const { data } = await supabase.auth.getUser()
    await supabase.auth.signOut()
    if (data.user) {
      await recordAudit({ workspaceId: null, actorType: 'user', actorId: data.user.id, action: 'auth.sign_out' })
    }
  }
  // 303 so the browser follows with GET.
  return NextResponse.redirect(new URL('/login', req.url), 303)
}

export function GET(req: NextRequest) {
  return NextResponse.redirect(new URL('/', req.url))
}
