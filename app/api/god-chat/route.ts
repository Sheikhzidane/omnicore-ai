import { requirePlatformAdminApi } from '@/lib/auth/api'
import { NextRequest, NextResponse } from 'next/server'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

/**
 * Ask-God endpoint: passes the user's question along with a compressed
 * snapshot of the system (god_status, recent lessons, cost, top agents)
 * so the answer is grounded in current state rather than hallucinated.
 *
 * Uses Haiku for speed+cost — this is for conversational context,
 * not deep reasoning. Target: <3s round-trip.
 */
export async function POST(req: NextRequest) {
  const authz = await requirePlatformAdminApi(req, 'ops.god-chat.post')
  if (!authz.ok) return authz.response

  const body = await req.json().catch(() => null) as { question?: string } | null
  const question = body?.question?.trim()
  if (!question) return NextResponse.json({ error: 'question required' }, { status: 400 })
  if (question.length > 500) return NextResponse.json({ error: 'question too long (max 500 chars)' }, { status: 400 })

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return NextResponse.json({ error: 'anthropic api key not configured' }, { status: 503 })

  const ctx = await buildContext()

  const system = `You are the God agent of an autonomous AI workforce — a terse, decisive Jarvis-style assistant. Answer the user's question grounded in the snapshot below. If the snapshot doesn't contain the answer, say so. Keep replies under 120 words, no bullet points unless strictly needed. Voice: dry, competent, first-person ("I"), British register.

<snapshot>
${JSON.stringify(ctx, null, 2).slice(0, 6000)}
</snapshot>`

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 400,
        system,
        messages: [{ role: 'user', content: question }],
      }),
    })
    if (!res.ok) {
      const errText = await res.text()
      return NextResponse.json({ error: `upstream ${res.status}: ${errText.slice(0, 200)}` }, { status: 502 })
    }
    const json = await res.json() as { content?: Array<{ text?: string }> }
    const reply = json.content?.[0]?.text?.trim() ?? '(no reply)'
    return NextResponse.json({ reply })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'unknown' }, { status: 500 })
  }
}

async function buildContext() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  const sb  = url && key ? createClient(url, key) : null

  let god: Record<string, unknown> | null = null
  let recentTasks: Array<{ title: string; status: string; agent: string | null }> = []
  if (sb) {
    const { data } = await sb.from('god_status').select('thought, meta, intent').eq('id', 1).single()
    god = data as Record<string, unknown> | null
    const r2 = await sb.from('todos').select('title, status, assigned_agent').order('updated_at', { ascending: false }).limit(10)
    recentTasks = ((r2.data as Array<{ title: string; status: string; assigned_agent: string | null }>) ?? [])
      .map(t => ({ title: t.title, status: t.status, agent: t.assigned_agent }))
  }

  const wisdom = readJson<{ cycles?: number; lessons?: string[]; roadmap?: { goals?: Array<{ title?: string; status?: string }> } }>(
    join(process.cwd(), 'scripts', 'god-wisdom.json'), {})
  const costs  = readJson<{ total?: number; byAgent?: Record<string, number> }>(
    join(process.cwd(), 'scripts', 'cost-log.json'), {})

  return {
    god,
    cycles:        wisdom.cycles ?? 0,
    activeGoals:   (wisdom.roadmap?.goals ?? []).filter(g => g.status === 'active').map(g => g.title),
    recentLessons: (wisdom.lessons ?? []).slice(-5),
    totalCost:     costs.total ?? 0,
    topAgentsByCost: Object.entries(costs.byAgent ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 5),
    recentTasks,
  }
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback
  try { return JSON.parse(readFileSync(path, 'utf8')) as T } catch { return fallback }
}
