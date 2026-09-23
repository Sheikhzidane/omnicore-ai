import { requirePlatformAdminApi, requirePlatformAdminReadApi } from '@/lib/auth/api'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { Resend } from 'resend'

// POST /api/newsletter/send
//   Body: { subject: string, html: string, fromName?: string, preview?: boolean, toSelfOnly?: boolean }
// Sends a broadcast to every confirmed subscriber. For safety the first
// send should pass { toSelfOnly: true } which only sends to RESEND_TEST_EMAIL.
export async function POST(req: NextRequest) {
  const authz = await requirePlatformAdminApi(req, 'ops.newsletter.send.post')
  if (!authz.ok) return authz.response

  const key = process.env.RESEND_API_KEY
  if (!key) {
    return NextResponse.json({
      error: 'RESEND_API_KEY not set. Add it in .env.local (and Vercel) — get a key at https://resend.com/api-keys',
    }, { status: 400 })
  }

  const body = await req.json().catch(() => ({})) as {
    subject?:    string
    html?:       string
    fromName?:   string
    preview?:    boolean
    toSelfOnly?: boolean
  }

  const subject = (body.subject ?? '').trim()
  const html    = (body.html ?? '').trim()
  if (!subject || !html) {
    return NextResponse.json({ error: 'subject and html are required' }, { status: 400 })
  }

  const fromAddress = process.env.RESEND_FROM ?? 'onboarding@resend.dev'
  const fromName    = body.fromName ?? 'Lewis'
  const from        = `${fromName} <${fromAddress}>`

  const resend = new Resend(key)

  // Dry-run / self-test first
  if (body.toSelfOnly) {
    const testTo = process.env.RESEND_TEST_EMAIL ?? 'lta.gb@outlook.com'
    const r = await resend.emails.send({
      from,
      to:      [testTo],
      subject: `[SELF-TEST] ${subject}`,
      html,
    })
    if (r.error) return NextResponse.json({ error: r.error.message }, { status: 502 })
    return NextResponse.json({ ok: true, mode: 'self-test', sentTo: [testTo], id: r.data?.id })
  }

  // Load subscriber list
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('subscribers')
    .select('email')
    .is('unsubscribed_at', null)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const emails = Array.from(new Set(
    (data ?? []).map(r => (r as { email: string }).email).filter(Boolean)
  ))

  if (emails.length === 0) {
    return NextResponse.json({ error: 'No subscribers to send to' }, { status: 400 })
  }

  // Preview only — show the list without actually sending
  if (body.preview) {
    return NextResponse.json({ ok: true, mode: 'preview', wouldSendTo: emails.length, sample: emails.slice(0, 10) })
  }

  // Resend batch API: up to 100 recipients per batch, BCC to avoid leaking addresses
  // For scale we chunk. Starts with small chunks to be safe.
  const CHUNK_SIZE = 50
  const sent: string[] = []
  const failed: Array<{ batch: number; error: string }> = []

  for (let i = 0; i < emails.length; i += CHUNK_SIZE) {
    const batch = emails.slice(i, i + CHUNK_SIZE)
    try {
      const r = await resend.emails.send({
        from,
        to:      [fromAddress], // Send to your own from address
        bcc:     batch,         // BCC the subscribers (privacy-respectful)
        subject,
        html:    html + unsubscribeFooter(),
      })
      if (r.error) throw new Error(r.error.message)
      sent.push(...batch)
      // Respect Resend rate limit (10 req/sec on free tier)
      if (i + CHUNK_SIZE < emails.length) await new Promise(r => setTimeout(r, 200))
    } catch (e) {
      failed.push({ batch: Math.floor(i / CHUNK_SIZE), error: e instanceof Error ? e.message : 'unknown' })
    }
  }

  return NextResponse.json({
    ok:      failed.length === 0,
    sent:    sent.length,
    total:   emails.length,
    failed,
  })
}

function unsubscribeFooter(): string {
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://task-dashboard-sigma-three.vercel.app'
  const host = site.replace(/^https?:\/\//, '').replace(/\/$/, '')
  return `
<hr style="margin-top:32px;border:0;border-top:1px solid #334">
<p style="font-family:monospace;font-size:11px;color:#64748b;text-align:center;">
  You're receiving this because you subscribed at
  <a href="${site}/subscribe" style="color:#0891b2">${host}</a>.
  <br>Reply with "unsubscribe" if you'd like out.
</p>`
}

// GET /api/newsletter/send — return status
export async function GET(req: NextRequest) {
  const authz = await requirePlatformAdminReadApi(req)
  if (!authz.ok) return authz.response

  return NextResponse.json({
    configured: Boolean(process.env.RESEND_API_KEY),
    from:       process.env.RESEND_FROM ?? 'onboarding@resend.dev (default test address)',
    note:       'Set RESEND_API_KEY + RESEND_FROM in .env.local. Verify your sending domain at https://resend.com/domains.',
  })
}
