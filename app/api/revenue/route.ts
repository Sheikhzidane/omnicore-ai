import type { NextRequest } from 'next/server'
import { requirePlatformAdminReadApi } from '@/lib/auth/api'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { NextResponse } from 'next/server'

const REVENUE_LOG = join(process.cwd(), 'scripts', 'revenue-log.json')

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const authz = await requirePlatformAdminReadApi(req)
  if (!authz.ok) return authz.response

  try {
    if (!existsSync(REVENUE_LOG)) {
      return NextResponse.json({
        posts: [], totalEstimatedEarnings: 0, totalEstimatedViews: 0,
        gumroadProducts: [], lastUpdated: null,
      })
    }
    const data = JSON.parse(readFileSync(REVENUE_LOG, 'utf8'))
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({
      posts: [], totalEstimatedEarnings: 0, totalEstimatedViews: 0,
      gumroadProducts: [], lastUpdated: null,
    })
  }
}
