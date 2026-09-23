import type { NextRequest } from 'next/server'
import { requirePlatformAdminApi, requirePlatformAdminReadApi } from '@/lib/auth/api'
import { NextResponse } from 'next/server'
import { execSync } from 'node:child_process'

export const dynamic = 'force-dynamic'

/**
 * Panic button — pauses (or resumes) all autonomous pm2 processes.
 * Safety net: ONE click to stop God, all ruflo specialists, revenue, poster.
 * The Next.js dev server keeps running so the dashboard stays visible.
 *
 * SECURITY: platform-admin session required and every action is written to
 * audit_log before it runs (requirePlatformAdminApi).
 */
const CONTROLLED = ['god', 'ruflo-agents', 'ruflo-orchestrator', 'revenue', 'promote', 'god-dreams', 'god-poster', 'watchdog', 'jarvis-briefings']

function pm2(action: 'stop' | 'start' | 'restart', target: string): { ok: boolean; detail: string } {
  try {
    const out = execSync(`pm2 ${action} ${target}`, { encoding: 'utf8', timeout: 20_000 })
    return { ok: true, detail: out.slice(-200) }
  } catch (e) {
    const err = e as { message?: string; stderr?: Buffer }
    return { ok: false, detail: (err.stderr?.toString() ?? err.message ?? 'unknown').slice(-300) }
  }
}

export async function POST(req: NextRequest) {
  const authz = await requirePlatformAdminApi(req, 'ops.panic.post')
  if (!authz.ok) return authz.response

  // Authorised by the platform-admin session + audit entry above. (The old
  // design required operators to paste PANIC_TOKEN into browser localStorage,
  // exposing a server secret to any XSS — removed.)

  let body: { action?: string; target?: string } = {}
  try { body = await req.json() } catch {}
  const action = body.action === 'resume' ? 'start'
               : body.action === 'restart' ? 'restart'
               : 'stop'

  // Allow individual process override; default is "all controlled processes"
  const target = body.target && CONTROLLED.includes(body.target) ? body.target : 'all'

  const result = pm2(action as 'stop' | 'start' | 'restart', target)

  return NextResponse.json({
    ok:      result.ok,
    action,
    target,
    detail:  result.detail,
    at:      new Date().toISOString(),
  })
}

export async function GET(req: NextRequest) {
  const authz = await requirePlatformAdminReadApi(req)
  if (!authz.ok) return authz.response

  try {
    const out = execSync('pm2 jlist', { encoding: 'utf8', timeout: 5_000 })
    const list = JSON.parse(out) as Array<{ name: string; pm2_env?: { status?: string } }>
    return NextResponse.json({
      configured: true,
      processes:  list.map(p => ({ name: p.name, status: p.pm2_env?.status ?? 'unknown' })),
    })
  } catch (e) {
    return NextResponse.json({ configured: true, processes: [], error: (e as Error).message?.slice(0, 100) })
  }
}
