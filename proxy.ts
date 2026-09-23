import { NextResponse, type NextRequest } from 'next/server'
import { rateLimit } from '@/lib/rate-limit'
import { classifyRoute } from '@/lib/auth/routes'
import { verifiedUser } from '@/lib/auth/api'
import { createRequestClient } from '@/lib/supabase/request'

/**
 * Request gate (Next 16 `proxy`, Node runtime):
 *   1. rate-limits /api/*
 *   2. classifies the route (lib/auth/routes.ts — default-deny)
 *   3. validates the Supabase session with the Auth server and refreshes cookies
 *   4. blocks unauthenticated users (401 / redirect to /login) and non-admins
 *      from ops routes (403 / redirect to /dashboard)
 *
 * This is NOT the only check: pages re-verify in layouts (requireUser /
 * requirePlatformAdmin) and privileged route handlers re-verify with
 * requirePlatformAdminApi. Never rely on the proxy alone.
 */
export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl
  const isApi = pathname.startsWith('/api/')

  if (isApi) {
    const limited = rateLimit(req, pathname)
    if (limited) return limited
  }

  const access = classifyRoute(pathname, req.method)
  const response = NextResponse.next({ request: req })
  const supabase = createRequestClient(req, () => response)

  if (access === 'public') {
    // Keep an existing session fresh on public pages; costs nothing without one.
    if (supabase && hasSupabaseCookie(req)) await supabase.auth.getUser()
    return response
  }

  const user = await verifiedUser(supabase)
  if (!user) {
    if (isApi) return NextResponse.json({ error: 'authentication required' }, { status: 401 })
    const login = new URL('/login', req.url)
    login.searchParams.set('next', pathname + req.nextUrl.search)
    return NextResponse.redirect(login)
  }

  if (access === 'ops') {
    const { data: isAdmin, error } = supabase
      ? await supabase.rpc('current_user_is_platform_admin')
      : { data: false, error: null }
    if (error || isAdmin !== true) {
      if (isApi) return NextResponse.json({ error: 'platform admin required' }, { status: 403 })
      return NextResponse.redirect(new URL('/dashboard?error=ops_forbidden', req.url))
    }
  }

  return response
}

function hasSupabaseCookie(req: NextRequest): boolean {
  return req.cookies.getAll().some(c => c.name.startsWith('sb-'))
}

export const config = {
  // Everything except build assets and static files served from /public.
  matcher: [
    '/((?!_next/static|_next/image|favicon\\.ico|pixel-agents/|briefings/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|mp3|wav|woff2?)$).*)',
  ],
}
