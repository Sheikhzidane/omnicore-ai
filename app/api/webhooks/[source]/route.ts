import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createHmac, timingSafeEqual } from 'node:crypto'

export const dynamic = 'force-dynamic'

interface WebhookContext {
  source: string
  event:  string
  payload: Record<string, unknown>
}

// Map raw webhook events → task templates. Each rule describes what task to
// spawn + which pool routes it. Extendable without touching agent code.
const RULES: Array<{
  when:  (ctx: WebhookContext) => boolean
  task:  (ctx: WebhookContext) => { title: string; priority: 'low'|'medium'|'high'|'critical'; category?: string }
}> = [
  {
    when: (c) => c.source === 'github' && c.event === 'star',
    task: (c) => ({
      title: `GitHub: thank new stargazer (@${(c.payload?.sender as { login?: string })?.login ?? 'unknown'}) via repo README footer`,
      priority: 'low',
      category: 'ui',
    }),
  },
  {
    when: (c) => c.source === 'github' && c.event === 'issues' && (c.payload?.action === 'opened'),
    task: (c) => ({
      title: `GitHub issue opened: "${String((c.payload?.issue as { title?: string })?.title ?? '').slice(0, 100)}" — triage + propose fix plan`,
      priority: 'high',
      category: 'analysis',
    }),
  },
  {
    when: (c) => c.source === 'github' && c.event === 'pull_request' && (c.payload?.action === 'opened'),
    task: (c) => ({
      title: `GitHub PR opened: review "${String((c.payload?.pull_request as { title?: string })?.title ?? '').slice(0, 100)}"`,
      priority: 'high',
      category: 'analysis',
    }),
  },
  {
    when: (c) => c.source === 'generic',
    task: (c) => ({
      title: `[webhook] ${c.event}: ${String(c.payload?.title ?? c.payload?.message ?? 'external trigger').slice(0, 120)}`,
      priority: (c.payload?.priority as 'low'|'medium'|'high'|'critical') ?? 'medium',
    }),
  },
]

function verifyGithubSig(body: string, sig: string | null): boolean {
  const secret = process.env.GITHUB_WEBHOOK_SECRET
  if (!secret) return true // no secret configured → open; document this in README
  if (!sig || !sig.startsWith('sha256=')) return false
  try {
    const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
    const a = Buffer.from(sig)
    const b = Buffer.from(expected)
    return a.length === b.length && timingSafeEqual(a, b)
  } catch { return false }
}

export async function POST(req: Request, { params }: { params: Promise<{ source: string }> }) {
  const { source } = await params
  if (!['github', 'generic', 'shopify', 'stripe'].includes(source)) {
    return NextResponse.json({ error: 'unknown-source' }, { status: 404 })
  }

  const raw = await req.text()
  let payload: Record<string, unknown> = {}
  try { payload = JSON.parse(raw) } catch {}

  // GitHub HMAC verification
  if (source === 'github') {
    const sig = req.headers.get('x-hub-signature-256')
    if (!verifyGithubSig(raw, sig)) return NextResponse.json({ error: 'bad-signature' }, { status: 401 })
  }
  // Generic webhooks use a shared token in the query string for dead-simple auth
  if (source === 'generic') {
    const url = new URL(req.url)
    const token = url.searchParams.get('token')
    if (process.env.GENERIC_WEBHOOK_TOKEN && token !== process.env.GENERIC_WEBHOOK_TOKEN) {
      return NextResponse.json({ error: 'bad-token' }, { status: 401 })
    }
  }

  const event = req.headers.get('x-github-event') ?? (payload.event as string) ?? 'unknown'
  const ctx: WebhookContext = { source, event, payload }

  // Find a matching rule
  const rule = RULES.find(r => r.when(ctx))
  if (!rule) {
    return NextResponse.json({ ok: true, matched: false, source, event }, { status: 200 })
  }

  const spec = rule.task(ctx)
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  )

  const { data, error } = await supabase.from('todos').insert({
    title:    spec.title,
    status:   'proposed',                            // goes to inbox, God decides when to promote
    priority: spec.priority,
    task_category: spec.category ?? 'other',
    metadata: { source: 'webhook', webhook_source: source, webhook_event: event, received_at: new Date().toISOString() },
  }).select('id').single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, matched: true, task_id: data.id, spawned: spec.title })
}

export async function GET(_req: Request, { params }: { params: Promise<{ source: string }> }) {
  const { source } = await params
  // Cheap liveness check — lets you curl the webhook URL to verify it's wired
  return NextResponse.json({
    source,
    configured:   true,
    acceptsPost:  true,
    rules:        RULES.length,
    sampleCurl:   `curl -X POST http://localhost:3000/api/webhooks/generic?token=$GENERIC_WEBHOOK_TOKEN -H 'content-type: application/json' -d '{"event":"alert","title":"Disk space 80%","priority":"high"}'`,
  })
}
