import 'server-only'
import { createServerClient } from '@supabase/ssr'
import type { NextRequest, NextResponse } from 'next/server'
import type { Database } from '@/types/database'
import { supabasePublicEnv } from './env'

/**
 * Supabase client bound to an incoming request's cookies (proxy + route
 * handlers). Refreshed auth cookies — and the no-store cache headers
 * @supabase/ssr requires alongside them — are written to `response` when one
 * is supplied, so a CDN can never cache one user's session for another.
 *
 * Returns null when Supabase isn't configured (callers treat that as
 * "not authenticated").
 */
export function createRequestClient(request: NextRequest, response?: () => NextResponse) {
  const env = supabasePublicEnv()
  if (!env) return null
  return createServerClient<Database>(env.url, env.anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      setAll(cookiesToSet, headers) {
        const res = response?.()
        if (!res) return
        cookiesToSet.forEach(({ name, value, options }) => res.cookies.set(name, value, options))
        Object.entries(headers ?? {}).forEach(([k, v]) => res.headers.set(k, v))
      },
    },
  })
}
