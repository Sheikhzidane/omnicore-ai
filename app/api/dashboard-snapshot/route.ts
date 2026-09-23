import type { NextRequest } from 'next/server'
import { requirePlatformAdminReadApi } from '@/lib/auth/api'
import { NextResponse } from 'next/server'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Consolidated "everything the dashboard needs" endpoint. One call instead of
 * ~12 independent polls. Client subscribes to deltas via Supabase realtime
 * afterwards; this just primes the initial view.
 *
 * Target latency: <200ms. Each section falls back to null on error so one
 * slow subsystem doesn't slow the whole snapshot.
 */
async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>(r => setTimeout(() => r(fallback), ms))])
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback
  try { return JSON.parse(readFileSync(path, 'utf8')) as T } catch { return fallback }
}

export async function GET(req: NextRequest) {
  const authz = await requirePlatformAdminReadApi(req)
  if (!authz.ok) return authz.response

  const start = Date.now()

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  const sb  = url && key ? createClient(url, key) : null

  const [god, costs, wisdom, verifications] = await Promise.all([
    // God status
    withTimeout(
      sb
        ? Promise.resolve(sb.from('god_status').select('thought, meta, intent, updated_at').eq('id', 1).single().then(r => r.data ?? null))
        : Promise.resolve(null),
      1500, null,
    ),
    // Cost log
    Promise.resolve(readJson(join(process.cwd(), 'scripts', 'cost-log.json'), { total: 0, sessions: [] as Array<{ at: string; cost: number }>, byAgent: {} as Record<string, number> })),
    // Wisdom (roadmap, lessons)
    Promise.resolve(readJson<{ cycles?: number; roadmap?: { goals?: unknown[] }; lessons?: string[]; taskStats?: unknown }>(
      join(process.cwd(), 'scripts', 'god-wisdom.json'),
      {},
    )),
    // Verification summary
    Promise.resolve(readJson<{ entries?: Array<{ ok: boolean; kind: string }> }>(
      join(process.cwd(), 'scripts', 'verification-log.json'),
      { entries: [] },
    )),
  ])

  // Derive quick stats rather than shipping raw arrays
  const today = new Date().toISOString().slice(0, 10)
  const todaySpend = (costs.sessions ?? [])
    .filter(s => s.at?.startsWith(today))
    .reduce((sum, s) => sum + (s.cost ?? 0), 0)

  const verifCounts = (() => {
    const counts: Record<string, { passed: number; failed: number }> = {}
    for (const e of (verifications.entries ?? [])) {
      const k = e.kind ?? 'unknown'
      counts[k] ??= { passed: 0, failed: 0 }
      if (e.ok) counts[k].passed++
      else      counts[k].failed++
    }
    return counts
  })()

  const activeGoals = (wisdom.roadmap?.goals ?? []) as Array<{ status?: string; title?: string }>
  const activeGoalTitle = activeGoals.find(g => g.status === 'active')?.title ?? null

  const response = NextResponse.json({
    at:        new Date().toISOString(),
    latency:   Date.now() - start,
    god: god ? {
      thought:     (god as { thought?: string }).thought ?? null,
      updated_at:  (god as { updated_at?: string }).updated_at ?? null,
      mood:        (god as { meta?: { mood?: string } }).meta?.mood ?? null,
      cycle:       (god as { intent?: { cycle?: number } }).intent?.cycle ?? null,
    } : null,
    cost: {
      total:       costs.total ?? 0,
      todaySpend,
      recentCallsCount: (costs.sessions ?? []).filter(s => s.at && Date.now() - new Date(s.at).getTime() < 3600_000).length,
    },
    roadmap: {
      cycles:         wisdom.cycles ?? 0,
      activeGoals:    activeGoals.filter(g => g.status === 'active').length,
      activeGoalTitle,
      lessonCount:    (wisdom.lessons ?? []).length,
    },
    verifications: {
      total:    (verifications.entries ?? []).length,
      passed:   (verifications.entries ?? []).filter(e => e.ok).length,
      failed:   (verifications.entries ?? []).filter(e => !e.ok).length,
      byKind:   verifCounts,
    },
  })

  // Edge-cache for 10s with 30s stale-while-revalidate so the second visitor
  // gets a near-instant response and the underlying file/DB reads happen in
  // the background. Snapshot data is by nature 30s-stale anyway (panels
  // realtime-subscribe for fresh deltas).
  response.headers.set('Cache-Control', 'public, s-maxage=10, stale-while-revalidate=30')
  return response
}
