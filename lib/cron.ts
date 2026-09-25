import 'server-only'
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { safeEqual } from '@/lib/social/providers/http'

/**
 * Vercel Cron authentication: Vercel sends `Authorization: Bearer $CRON_SECRET`.
 * Fails closed — with no CRON_SECRET configured every cron call is refused.
 */
export function requireCron(req: NextRequest): { ok: true } | { ok: false; response: NextResponse } {
  const secret = process.env.CRON_SECRET
  if (!secret || secret.length < 16) return { ok: false, response: NextResponse.json({ error: 'cron not configured' }, { status: 503 }) }
  const got = req.headers.get('authorization') ?? ''
  if (!safeEqual(got, `Bearer ${secret}`)) return { ok: false, response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) }
  return { ok: true }
}
