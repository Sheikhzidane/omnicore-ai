import { NextRequest, NextResponse } from 'next/server'
import { rateLimit } from '@/lib/rate-limit'

// Single-purpose middleware: rate limiting only. Anything else that
// needs to run per-request belongs in route handlers, not here — this
// runs on every matched path and contributes to cold-start size.
export function proxy(req: NextRequest) {
  const limited = rateLimit(req, req.nextUrl.pathname)
  if (limited) return limited
  return NextResponse.next()
}

export const config = {
  // Apply only to /api routes — the front-end pages don't need throttling
  matcher: ['/api/:path*'],
}
