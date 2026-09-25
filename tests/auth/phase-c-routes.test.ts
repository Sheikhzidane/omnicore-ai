import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { NextRequest } from 'next/server'
import { classifyRoute } from '@/lib/auth/routes'
import { verifyStripeSignature, stripeEventToRevenue } from '@/lib/payments/stripe'
import { toEngagement } from '@/lib/webhooks/social'

process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:9'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'

const req = (path: string, init: RequestInit = {}) => new NextRequest(new URL(path, 'http://localhost'), init as never)

test('route policy: cron and platform webhooks are public (verified in-handler); OAuth needs a session', () => {
  assert.equal(classifyRoute('/api/cron/publish', 'GET'), 'public')
  assert.equal(classifyRoute('/api/cron/publish', 'POST'), 'ops', 'only GET is public')
  assert.equal(classifyRoute('/api/social-webhooks/instagram', 'POST'), 'public')
  assert.equal(classifyRoute('/api/social/connect/x', 'GET'), 'user')
  assert.equal(classifyRoute('/api/social/callback/x', 'GET'), 'user')
})

test('cron endpoints fail closed without CRON_SECRET and reject wrong bearer tokens', async () => {
  for (const mod of ['publish', 'agents', 'metrics']) {
    const { GET } = await import(`@/app/api/cron/${mod}/route`)
    delete process.env.CRON_SECRET
    assert.equal((await GET(req(`/api/cron/${mod}`))).status, 503, mod)
    process.env.CRON_SECRET = 'a-very-long-cron-secret-value'
    assert.equal((await GET(req(`/api/cron/${mod}`, { headers: { authorization: 'Bearer wrong' } }))).status, 401, mod)
    assert.equal((await GET(req(`/api/cron/${mod}`))).status, 401, mod)
  }
  delete process.env.CRON_SECRET
})

test('OAuth routes reject unauthenticated callers', async () => {
  const { GET: connect } = await import('@/app/api/social/connect/[platform]/route')
  const { GET: callback } = await import('@/app/api/social/callback/[platform]/route')
  const params = { params: Promise.resolve({ platform: 'x' }) }
  assert.equal((await connect(req('/api/social/connect/x?characterId=x'), params)).status, 401)
  assert.equal((await callback(req('/api/social/callback/x?code=c&state=s'), params)).status, 401)
})

test('social webhooks reject unsigned or forged events before touching the database', async () => {
  const { POST, GET } = await import('@/app/api/social-webhooks/[platform]/route')
  process.env.META_APP_SECRET = 'meta-secret'
  const body = '{"object":"instagram","entry":[]}'
  const p = (platform: string) => ({ params: Promise.resolve({ platform }) })
  assert.equal((await POST(req('/api/social-webhooks/instagram', { method: 'POST', body }), p('instagram'))).status, 401)
  assert.equal((await POST(req('/api/social-webhooks/instagram', { method: 'POST', body, headers: { 'x-hub-signature-256': 'sha256=forged' } }), p('instagram'))).status, 401)
  assert.equal((await POST(req('/api/social-webhooks/youtube', { method: 'POST', body }), p('youtube'))).status, 404, 'no webhook support → 404')
  delete process.env.META_WEBHOOK_VERIFY_TOKEN
  assert.equal((await GET(req('/api/social-webhooks/instagram?hub.mode=subscribe&hub.verify_token=&hub.challenge=1'), p('instagram'))).status, 403, 'handshake fails closed without a verify token')
  delete process.env.META_APP_SECRET
})

test('stripe webhook: signature required; only metadata-tagged paid events become revenue', async () => {
  const { POST } = await import('@/app/api/webhooks/stripe/route')
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test'
  assert.equal((await POST(req('/api/webhooks/stripe', { method: 'POST', body: '{}' }))).status, 401)
  delete process.env.STRIPE_WEBHOOK_SECRET
  const t = Math.floor(Date.now() / 1000), raw = '{"id":"evt_1"}'
  const sig = createHmac('sha256', 'whsec_test').update(`${t}.${raw}`).digest('hex')
  assert.equal(verifyStripeSignature(raw, `t=${t},v1=${sig}`, 'whsec_test'), true)
  assert.equal(verifyStripeSignature(raw, `t=${t},v1=${sig}`, undefined), false)
  assert.equal(verifyStripeSignature(raw + ' ', `t=${t},v1=${sig}`, 'whsec_test'), false)
  assert.equal(verifyStripeSignature(raw, `t=${t - 3600},v1=${createHmac('sha256', 'whsec_test').update(`${t - 3600}.${raw}`).digest('hex')}`, 'whsec_test'), false)

  const ws = '0b6f7c1e-8d1a-4c4e-9a53-5b8f0c2d1e11'
  const paid = stripeEventToRevenue({ id: 'e', type: 'checkout.session.completed', created: t, data: { object: { mode: 'payment', payment_status: 'paid', amount_total: 1999, currency: 'gbp', payment_intent: 'pi_1', metadata: { omnicore_workspace_id: ws } } } })
  assert.ok(paid && 'workspaceId' in paid)
  assert.equal(paid.amountCents, 1999)
  assert.equal(paid.currency, 'GBP')
  assert.equal(stripeEventToRevenue({ id: 'e', type: 'checkout.session.completed', created: t, data: { object: { mode: 'payment', payment_status: 'paid', amount_total: 1999 } } }), null, 'untagged payments are not attributed')
  assert.equal(stripeEventToRevenue({ id: 'e', type: 'checkout.session.completed', created: t, data: { object: { mode: 'payment', payment_status: 'unpaid', metadata: { omnicore_workspace_id: ws } } } }), null)
})

test('webhook events become inbox items; the character’s own posts are ignored', () => {
  const c = toEngagement('instagram', { eventId: 'comments:C1', eventType: 'comments', externalAccountId: '1784', payload: { id: 'C1', text: 'love this', from: { id: '9', username: 'fan' }, media: { id: 'M1' } } })
  assert.deepEqual(c, { kind: 'comment', externalId: 'C1', parentExternalId: 'M1', authorHandle: 'fan', authorExternalId: '9', body: 'love this' })
  assert.equal(toEngagement('x', { eventId: 'e', eventType: 'tweet_create', externalAccountId: '1', payload: { id: '5', text: 'my own post', authorId: '1' } }), null)
  assert.equal(toEngagement('x', { eventId: 'e', eventType: 'tweet_create', externalAccountId: '1', payload: { id: '6', text: '@nova hi', authorId: '2', author: 'fan', inReplyTo: null } })?.kind, 'mention')
  assert.equal(toEngagement('tiktok', { eventId: 'e', eventType: 'post.publish.complete', payload: {} }), null)
})
