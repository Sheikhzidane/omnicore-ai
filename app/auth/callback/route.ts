import { NextResponse, type NextRequest } from 'next/server'
import type { EmailOtpType } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { isEmailAllowed, parseEmailList, safeNextPath } from '@/lib/auth/routes'
import { syncPlatformAdmin } from '@/lib/auth/ops-admin'
import { recordAudit } from '@/lib/audit'

const OTP_TYPES = new Set<EmailOtpType>(['magiclink', 'email', 'signup', 'invite', 'recovery', 'email_change'])

/** Completes a magic-link / OAuth sign-in: exchanges the one-time code for a session. */
export async function GET(req: NextRequest) {
  const url = req.nextUrl
  const next = safeNextPath(url.searchParams.get('next'))
  const code = url.searchParams.get('code')
  const tokenHash = url.searchParams.get('token_hash')
  const type = url.searchParams.get('type') as EmailOtpType | null
  const fail = () => NextResponse.redirect(new URL('/login?error=auth_callback', req.url))

  const supabase = await createClient()
  let ok = false
  if (code) {
    ok = !(await supabase.auth.exchangeCodeForSession(code)).error
  } else if (tokenHash && type && OTP_TYPES.has(type)) {
    ok = !(await supabase.auth.verifyOtp({ token_hash: tokenHash, type })).error
  }
  if (!ok) return fail()

  const { data } = await supabase.auth.getUser()
  if (!data.user) return fail()
  if (!isEmailAllowed(data.user.email, parseEmailList(process.env.AUTH_ALLOWED_EMAILS))) {
    await supabase.auth.signOut()
    return NextResponse.redirect(new URL('/login?error=not_allowed', req.url))
  }

  await syncPlatformAdmin(data.user)
  await recordAudit({ workspaceId: null, actorType: 'user', actorId: data.user.id, action: 'auth.sign_in', details: { method: 'link' } })
  return NextResponse.redirect(new URL(next, req.url))
}
