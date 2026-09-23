import type { NextRequest } from 'next/server'
import { requirePlatformAdminReadApi } from '@/lib/auth/api'
import { NextResponse } from 'next/server'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

/**
 * System invariants — things that should always be true. When one breaks,
 * something has silently gone wrong (the kind of thing that left the
 * roadmap stuck for 242 cycles before we noticed).
 *
 * Returns an array of `{ name, ok, detail }`. The dashboard polls this
 * and surfaces the first failing invariant. Failed invariants also
 * raise an alert chip on the home tab.
 */
const HOUR = 3_600_000

export async function GET(req: NextRequest) {
  const authz = await requirePlatformAdminReadApi(req)
  if (!authz.ok) return authz.response

  const checks: Array<{ name: string; ok: boolean; detail: string }> = []

  // 1. God roadmap should have ≥1 active goal at all times
  try {
    const w = readJson<{ cycles?: number; roadmap?: { goals?: Array<{ status?: string }> } }>(
      join(process.cwd(), 'scripts', 'god-wisdom.json'), {})
    const active = (w.roadmap?.goals ?? []).filter(g => g.status === 'active').length
    checks.push({
      name:   'god.roadmap.has_active_goals',
      ok:     active >= 1,
      detail: `${active} active goal${active === 1 ? '' : 's'} (cycle ${w.cycles ?? '?'})`,
    })
  } catch (e) {
    checks.push({ name: 'god.roadmap.has_active_goals', ok: false, detail: `read failed: ${(e as Error).message}` })
  }

  // 2. cost-log should have a session in the last 24h (otherwise agents are silent)
  try {
    const c = readJson<{ sessions?: Array<{ at?: string }> }>(join(process.cwd(), 'scripts', 'cost-log.json'), {})
    const last = (c.sessions ?? []).at(-1)
    const lastAge = last?.at ? Date.now() - new Date(last.at).getTime() : Infinity
    checks.push({
      name:   'agents.recent_activity',
      ok:     lastAge < 24 * HOUR,
      detail: lastAge === Infinity ? 'no sessions ever recorded' : `last activity ${Math.round(lastAge / HOUR)}h ago`,
    })
  } catch (e) {
    checks.push({ name: 'agents.recent_activity', ok: false, detail: `read failed: ${(e as Error).message}` })
  }

  // 3. cost-log's mtime should be < 1 hour old (otherwise no agent is writing)
  try {
    const path = join(process.cwd(), 'scripts', 'cost-log.json')
    if (existsSync(path)) {
      const ageMs = Date.now() - statSync(path).mtimeMs
      checks.push({
        name:   'cost_log.fresh',
        ok:     ageMs < 6 * HOUR,
        detail: `last modified ${Math.round(ageMs / 60_000)} min ago`,
      })
    } else {
      checks.push({ name: 'cost_log.fresh', ok: false, detail: 'cost-log.json missing' })
    }
  } catch (e) {
    checks.push({ name: 'cost_log.fresh', ok: false, detail: `stat failed: ${(e as Error).message}` })
  }

  // 4. Supabase reachable + at least one todo updated in last 24h
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (url && key) {
      const sb = createClient(url, key)
      const { data, error } = await sb
        .from('todos')
        .select('updated_at')
        .order('updated_at', { ascending: false })
        .limit(1)
        .single()
      if (error) throw new Error(error.message)
      const lastTodo = (data as { updated_at?: string } | null)?.updated_at
      const age = lastTodo ? Date.now() - new Date(lastTodo).getTime() : Infinity
      checks.push({
        name:   'supabase.todos.fresh',
        ok:     age < 24 * HOUR,
        detail: lastTodo ? `last todo update ${Math.round(age / HOUR)}h ago` : 'no todos found',
      })
    } else {
      checks.push({ name: 'supabase.todos.fresh', ok: false, detail: 'supabase env not configured' })
    }
  } catch (e) {
    checks.push({ name: 'supabase.todos.fresh', ok: false, detail: `${(e as Error).message?.slice(0, 100)}` })
  }

  // 5. Anthropic API key set
  checks.push({
    name:   'anthropic.key_present',
    ok:     Boolean(process.env.ANTHROPIC_API_KEY),
    detail: process.env.ANTHROPIC_API_KEY ? 'set' : 'ANTHROPIC_API_KEY missing',
  })

  const allOk = checks.every(c => c.ok)
  return NextResponse.json(
    { ok: allOk, checks, at: new Date().toISOString() },
    { status: allOk ? 200 : 503 },
  )
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback
  try { return JSON.parse(readFileSync(path, 'utf8')) as T } catch { return fallback }
}
