import type { NextRequest } from 'next/server'
import { requirePlatformAdminReadApi } from '@/lib/auth/api'
import { NextResponse } from 'next/server'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export const dynamic = 'force-dynamic'

const PATH = join(process.cwd(), 'scripts', 'god-wisdom.json')

export async function GET(req: NextRequest) {
  const authz = await requirePlatformAdminReadApi(req)
  if (!authz.ok) return authz.response

  try {
    if (!existsSync(PATH)) return NextResponse.json({ cycles: 0, roadmap: { goals: [] } })
    const data = JSON.parse(readFileSync(PATH, 'utf8'))
    // Trim the response — dashboard only needs cycles + roadmap + decisionHistory
    return NextResponse.json({
      cycles:         data.cycles ?? 0,
      roadmap:        data.roadmap ?? { goals: [] },
      decisionHistory: (data.decisionHistory ?? []).slice(-20),
      lessons:        (data.lessons ?? []).slice(-10),
      taskStats:      data.taskStats ?? null,
    })
  } catch {
    return NextResponse.json({ cycles: 0, roadmap: { goals: [] } })
  }
}
