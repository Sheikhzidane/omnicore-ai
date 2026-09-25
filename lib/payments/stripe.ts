import { hmacHex, safeEqual } from '@/lib/social/providers/http'

/**
 * Stripe webhook verification + mapping to revenue rows. Revenue is recorded
 * ONLY from signature-verified Stripe events that carry Omnicore metadata
 * (set on your Payment Links / Checkout Sessions / Subscriptions):
 *   omnicore_workspace_id (required), omnicore_character_id, omnicore_product_id
 */

export function verifyStripeSignature(rawBody: string, header: string | null, secret: string | undefined, now = Date.now(), toleranceSec = 300): boolean {
  if (!secret || !header) return false
  const parts = header.split(',').map(p => p.split('=') as [string, string])
  const t = parts.find(([k]) => k === 't')?.[1]
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v)
  if (!t || !sigs.length) return false
  if (Math.abs(now / 1000 - Number(t)) > toleranceSec) return false
  const expected = hmacHex(secret, `${t}.${rawBody}`)
  return sigs.some(s => safeEqual(s, expected))
}

export interface RevenueDraft {
  workspaceId: string
  characterId: string | null
  productId: string | null
  sourceType: 'product' | 'subscription'
  amountCents: number
  currency: string
  occurredOn: string
  externalRef: string
  description: string
}

type Obj = Record<string, unknown>
const meta = (o: Obj | undefined) => (o?.metadata ?? {}) as Record<string, string>
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const uuidOrNull = (v: string | undefined) => (v && UUID.test(v) ? v : null)

export function stripeEventToRevenue(event: { id: string; type: string; created: number; data: { object: Obj } }): RevenueDraft | { refundOf: string } | null {
  const o = event.data.object
  const day = new Date(event.created * 1000).toISOString().slice(0, 10)
  if (event.type === 'checkout.session.completed' && o.payment_status === 'paid' && o.mode === 'payment') {
    const m = meta(o)
    if (!uuidOrNull(m.omnicore_workspace_id)) return null
    return { workspaceId: m.omnicore_workspace_id, characterId: uuidOrNull(m.omnicore_character_id), productId: uuidOrNull(m.omnicore_product_id), sourceType: 'product',
      amountCents: Number(o.amount_total ?? 0), currency: String(o.currency ?? 'usd').toUpperCase(), occurredOn: day, externalRef: `stripe:${String(o.payment_intent ?? o.id)}`, description: 'Stripe checkout' }
  }
  if (event.type === 'invoice.paid') {
    const lines = ((o.lines as Obj | undefined)?.data ?? []) as Obj[]
    const m = { ...meta((o.subscription_details as Obj | undefined)), ...meta(lines[0]), ...meta(o) }
    if (!uuidOrNull(m.omnicore_workspace_id) || Number(o.amount_paid ?? 0) <= 0) return null
    return { workspaceId: m.omnicore_workspace_id, characterId: uuidOrNull(m.omnicore_character_id), productId: uuidOrNull(m.omnicore_product_id), sourceType: 'subscription',
      amountCents: Number(o.amount_paid), currency: String(o.currency ?? 'usd').toUpperCase(), occurredOn: day, externalRef: `stripe:${String(o.payment_intent ?? o.id)}`, description: 'Stripe subscription invoice' }
  }
  if (event.type === 'charge.refunded' && o.payment_intent) return { refundOf: `stripe:${String(o.payment_intent)}` }
  return null
}
