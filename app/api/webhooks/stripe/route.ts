import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { stripeEventToRevenue, verifyStripeSignature } from '@/lib/payments/stripe'
import type { Json } from '@/types/database'

export const dynamic = 'force-dynamic'

/** Stripe → revenue ledger. Fails closed without STRIPE_WEBHOOK_SECRET; idempotent per event id. */
export async function POST(req: NextRequest) {
  const raw = await req.text()
  if (!verifyStripeSignature(raw, req.headers.get('stripe-signature'), process.env.STRIPE_WEBHOOK_SECRET)) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 })
  }
  const event = JSON.parse(raw) as { id: string; type: string; created: number; data: { object: Record<string, unknown> } }
  const db = createAdminClient()
  const draft = stripeEventToRevenue(event)
  const wsId = draft && 'workspaceId' in draft ? draft.workspaceId : null
  const ws = wsId ? (await db.from('workspaces').select('id').eq('id', wsId).maybeSingle()).data : null
  const ins = await db.from('webhook_events').insert({
    workspace_id: ws?.id ?? null, provider: 'stripe', event_id: event.id, event_type: event.type.slice(0, 100), signature_valid: true,
    payload: { type: event.type } as Json, status: 'received',
  }).select('id').single()
  if (ins.error) return NextResponse.json({ ok: true, duplicate: true })

  let status: 'processed' | 'ignored' = 'ignored'
  if (draft && 'refundOf' in draft) {
    const r = await db.from('revenue').update({ status: 'refunded' }).eq('external_ref', draft.refundOf).select('id')
    if (r.data?.length) status = 'processed'
  } else if (draft && ws) {
    const r = await db.from('revenue').insert({
      workspace_id: ws.id, character_id: draft.characterId, product_id: draft.productId, source_type: draft.sourceType, amount_cents: draft.amountCents,
      currency: draft.currency, occurred_on: draft.occurredOn, status: 'received', external_ref: draft.externalRef, description: draft.description,
    })
    // A character/product id from metadata that is not in this workspace fails the composite FK — recorded, not guessed.
    status = r.error ? 'ignored' : 'processed'
    if (r.error) await db.from('webhook_events').update({ error: r.error.message.slice(0, 500) }).eq('id', ins.data.id)
  }
  await db.from('webhook_events').update({ status, processed_at: new Date().toISOString() }).eq('id', ins.data.id)
  return NextResponse.json({ ok: true, status })
}
