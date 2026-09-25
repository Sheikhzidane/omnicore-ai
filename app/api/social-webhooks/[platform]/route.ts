import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getSocialProvider } from '@/lib/social/providers'
import { toEngagement } from '@/lib/webhooks/social'
import type { Json } from '@/types/database'

export const dynamic = 'force-dynamic'

/** Subscription handshakes (Meta hub.challenge, X CRC). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ platform: string }> }) {
  const { platform } = await params
  const provider = getSocialProvider(platform)
  const hs = provider?.webhookHandshake?.({ method: 'GET', url: req.nextUrl, headers: req.headers, rawBody: '' }, process.env)
  if (!hs) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return new NextResponse(hs.body, { status: hs.status, headers: { 'Content-Type': hs.contentType ?? 'text/plain' } })
}

/**
 * Signed platform events. Unverifiable requests are rejected before any
 * parsing; verified events are stored once (unique provider+event_id) and
 * comments/mentions land in the engagement inbox for human handling.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ platform: string }> }) {
  const { platform } = await params
  const provider = getSocialProvider(platform)
  if (!provider?.verifyWebhook || !provider.parseWebhook) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const rawBody = await req.text()
  if (rawBody.length > 1_000_000) return NextResponse.json({ error: 'too large' }, { status: 413 })
  if (!provider.verifyWebhook({ method: 'POST', url: req.nextUrl, headers: req.headers, rawBody }, process.env)) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 })
  }
  let body: unknown
  try { body = JSON.parse(rawBody) } catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }) }

  const db = createAdminClient()
  let stored = 0, inbox = 0
  for (const e of provider.parseWebhook(body)) {
    const acct = e.externalAccountId
      ? (await db.from('social_accounts').select('id, workspace_id, character_id').eq('platform', platform).eq('external_account_id', e.externalAccountId).maybeSingle()).data
      : null
    const ins = await db.from('webhook_events').insert({
      workspace_id: acct?.workspace_id ?? null, provider: platform, event_id: e.eventId.slice(0, 200), event_type: e.eventType.slice(0, 100),
      signature_valid: true, payload: e.payload as Json, status: acct ? 'received' : 'ignored', error: acct ? null : 'no connected account matches',
    }).select('id').single()
    if (ins.error) continue // duplicate delivery (unique provider+event_id) or invalid — never processed twice
    stored++
    const draft = acct ? toEngagement(platform, e) : null
    if (acct && draft) {
      const eng = await db.from('engagement_items').upsert({
        workspace_id: acct.workspace_id, character_id: acct.character_id, social_account_id: acct.id, platform, kind: draft.kind,
        external_id: draft.externalId, parent_external_id: draft.parentExternalId, author_handle: draft.authorHandle,
        author_external_id: draft.authorExternalId, body: draft.body, received_at: new Date().toISOString(), status: 'new',
      }, { onConflict: 'platform,social_account_id,external_id', ignoreDuplicates: true })
      if (!eng.error) inbox++
    }
    await db.from('webhook_events').update({ status: acct ? 'processed' : 'ignored', processed_at: new Date().toISOString() }).eq('id', ins.data.id)
  }
  return NextResponse.json({ ok: true, stored, inbox })
}
