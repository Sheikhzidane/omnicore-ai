import type { NextRequest } from 'next/server'
import { requirePlatformAdminReadApi } from '@/lib/auth/api'
import { NextResponse } from 'next/server'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export const dynamic = 'force-dynamic'

interface Entry {
  at:      string
  kind:    string       // 'devto-post' | 'seo-page' | 'git-commit'
  ok:      boolean
  detail?: string
  context?: Record<string, unknown>
  bytes?:   number
  status?:  number
}

const LOG_PATH = join(process.cwd(), 'scripts', 'verification-log.json')

export async function GET(req: NextRequest) {
  const authz = await requirePlatformAdminReadApi(req)
  if (!authz.ok) return authz.response

  if (!existsSync(LOG_PATH)) {
    return NextResponse.json({ entries: [], summary: { total: 0, passed: 0, failed: 0, byKind: {} } })
  }

  try {
    const raw = JSON.parse(readFileSync(LOG_PATH, 'utf8'))
    const entries: Entry[] = Array.isArray(raw.entries) ? raw.entries : []
    const last100 = entries.slice(-100).reverse()

    const summary = { total: 0, passed: 0, failed: 0, byKind: {} as Record<string, { passed: number; failed: number }> }
    for (const e of entries) {
      summary.total++
      if (e.ok) summary.passed++
      else      summary.failed++
      const k = e.kind ?? 'unknown'
      summary.byKind[k] ??= { passed: 0, failed: 0 }
      if (e.ok) summary.byKind[k].passed++
      else      summary.byKind[k].failed++
    }

    return NextResponse.json({ entries: last100, summary })
  } catch {
    return NextResponse.json({ entries: [], summary: { total: 0, passed: 0, failed: 0, byKind: {} } })
  }
}
