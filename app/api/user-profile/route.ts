import type { NextRequest } from 'next/server'
import { requirePlatformAdminApi, requirePlatformAdminReadApi } from '@/lib/auth/api'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { NextResponse } from 'next/server'

const PROFILE_PATH = join(process.cwd(), 'scripts', 'user-profile.json')

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const authz = await requirePlatformAdminReadApi(req)
  if (!authz.ok) return authz.response

  try {
    if (!existsSync(PROFILE_PATH)) return NextResponse.json({ inferred: null, updated_at: null })
    const data = JSON.parse(readFileSync(PROFILE_PATH, 'utf8'))
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ inferred: null, updated_at: null })
  }
}

/** Minimal PATCH: user can correct an inferred fact from the dashboard. */
export async function PATCH(req: NextRequest) {
  const authz = await requirePlatformAdminApi(req, 'ops.user-profile.patch')
  if (!authz.ok) return authz.response

  try {
    const body  = await req.json()
    const patch = body?.patch
    if (!patch || typeof patch !== 'object') return NextResponse.json({ ok: false }, { status: 400 })

    const existing = existsSync(PROFILE_PATH) ? JSON.parse(readFileSync(PROFILE_PATH, 'utf8')) : {}
    const next = {
      ...existing,
      inferred: { ...(existing.inferred ?? {}), ...patch },
      updated_at: new Date().toISOString(),
      last_edited_by_user: true,
    }
    writeFileSync(PROFILE_PATH, JSON.stringify(next, null, 2), 'utf8')
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: false }, { status: 500 })
  }
}
