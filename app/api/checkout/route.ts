import { requirePlatformAdminApi, requirePlatformAdminReadApi } from '@/lib/auth/api'
import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'

// POST /api/checkout — create a Stripe Checkout session.
// Config in .env.local:
//   STRIPE_SECRET_KEY          (server-side, from dashboard.stripe.com/apikeys)
//   STRIPE_PRICE_ID            (the one-time or recurring price to sell)
//   STRIPE_SUCCESS_URL         (where the buyer lands after paying)
//   STRIPE_CANCEL_URL          (where they land if they cancel)
//
// Without STRIPE_SECRET_KEY the route returns 503 — safe to leave unset
// until you're ready to skip Gumroad's fee.
export async function POST(req: NextRequest) {
  const authz = await requirePlatformAdminApi(req, 'ops.checkout.post')
  if (!authz.ok) return authz.response

  const key = process.env.STRIPE_SECRET_KEY
  if (!key) {
    return NextResponse.json({
      error: 'Stripe not configured. Set STRIPE_SECRET_KEY + STRIPE_PRICE_ID in .env.local when ready.',
    }, { status: 503 })
  }

  const priceId = process.env.STRIPE_PRICE_ID
  if (!priceId) {
    return NextResponse.json({ error: 'STRIPE_PRICE_ID not set' }, { status: 500 })
  }

  const body = await req.json().catch(() => ({})) as {
    email?:   string
    priceId?: string
  }

  const stripe = new Stripe(key, { apiVersion: '2026-03-25.dahlia' })

  try {
    const origin = req.headers.get('origin') ?? process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'
    const session = await stripe.checkout.sessions.create({
      mode:        'payment',
      line_items:  [{ price: body.priceId ?? priceId, quantity: 1 }],
      customer_email: body.email,
      success_url: process.env.STRIPE_SUCCESS_URL ?? `${origin}/?purchased=1`,
      cancel_url:  process.env.STRIPE_CANCEL_URL  ?? `${origin}/?cancelled=1`,
      allow_promotion_codes: true,
    })
    return NextResponse.json({ ok: true, url: session.url, id: session.id })
  } catch (e) {
    return NextResponse.json({
      error: e instanceof Error ? e.message : 'checkout error',
    }, { status: 502 })
  }
}

export async function GET(req: NextRequest) {
  const authz = await requirePlatformAdminReadApi(req)
  if (!authz.ok) return authz.response

  return NextResponse.json({
    configured: Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID),
    hint: 'To activate: set STRIPE_SECRET_KEY + STRIPE_PRICE_ID in .env.local, then POST to this route.',
  })
}
