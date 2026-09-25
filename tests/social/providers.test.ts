import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import { SOCIAL_PROVIDERS, SocialApiError, UnsupportedPublishError, type FetchFn, type PublishInput } from '@/lib/social/providers'
import { createInstagramProvider } from '@/lib/social/providers/instagram'
import { createTikTokProvider } from '@/lib/social/providers/tiktok'
import { beginOAuth, verifyOAuthState, OAuthStateError } from '@/lib/social/oauth'
import { needsRefresh } from '@/lib/social/tokens'

type Call = { url: string; method: string; headers: Record<string, string>; body: string }

/** Fake fetch: routes by substring, records every call. */
function fakeFetch(routes: [string, (c: Call) => { status?: number; body?: unknown; headers?: Record<string, string>; raw?: ArrayBuffer }][]) {
  const calls: Call[] = []
  const f: FetchFn = async (input, init = {}) => {
    const url = String(input)
    const headers: Record<string, string> = {}
    new Headers(init.headers as HeadersInit).forEach((v, k) => { headers[k] = v })
    const body = typeof init.body === 'string' ? init.body : init.body instanceof FormData ? '[form]' : init.body ? '[binary]' : ''
    const call = { url, method: init.method ?? 'GET', headers, body }
    calls.push(call)
    const route = routes.find(([k]) => url.includes(k))
    if (!route) return new Response('not found', { status: 404 })
    const r = route[1](call)
    if (r.raw) return new Response(r.raw, { status: 200 })
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers })
  }
  return { f, calls }
}

const ENV = {
  META_APP_ID: 'meta-id', META_APP_SECRET: 'meta-secret', META_WEBHOOK_VERIFY_TOKEN: 'verify-me',
  TIKTOK_CLIENT_KEY: 'tt-key', TIKTOK_CLIENT_SECRET: 'tt-secret',
  GOOGLE_OAUTH_CLIENT_ID: 'g-id', GOOGLE_OAUTH_CLIENT_SECRET: 'g-secret',
  X_CLIENT_ID: 'x-id', X_CLIENT_SECRET: 'x-secret', X_CONSUMER_SECRET: 'x-consumer',
  NEXT_PUBLIC_SITE_URL: 'https://app.example.com',
}
const TOKENS = { accessToken: 'SECRET-ACCESS-TOKEN', refreshToken: 'SECRET-REFRESH', scopes: [], accountRef: '17841400000' }
const post = (media: PublishInput['media'], extra: Partial<PublishInput> = {}): PublishInput =>
  ({ caption: 'Hello\n\nAI-generated virtual character', format: 'post', media, isSponsored: false, aiGenerated: true, ...extra })

test('every provider declares requirements, scopes, and no engagement-automation capability', () => {
  for (const p of Object.values(SOCIAL_PROVIDERS)) {
    assert.ok(p.requirements.length > 0, p.platform)
    assert.ok(p.scopes.length > 0, p.platform)
    assert.equal(p.configured({}), false, `${p.platform} must be unconfigured without env`)
    assert.equal(p.configured(ENV), true, p.platform)
    const keys = Object.keys(p.capabilities).sort()
    assert.deepEqual(keys, ['ageRestriction', 'metrics', 'publishImage', 'publishText', 'publishVideo', 'replyToComments', 'webhooks'])
    for (const k of Object.keys(p)) assert.doesNotMatch(k, /follow|like|dm|directMessage|massMessage|scrape/i, `${p.platform}.${k}`)
  }
})

test('authorization URLs carry state, redirect and (where required) PKCE', () => {
  for (const p of Object.values(SOCIAL_PROVIDERS)) {
    const u = new URL(p.authorizationUrl({ state: 'st4te', redirectUri: 'https://app.example.com/cb', codeChallenge: 'chal' }, ENV))
    assert.equal(u.protocol, 'https:')
    assert.equal(u.searchParams.get('state'), 'st4te')
    assert.equal(u.searchParams.get('redirect_uri'), 'https://app.example.com/cb')
    if (p.usesPkce) assert.equal(u.searchParams.get('code_challenge_method'), 'S256')
    assert.ok(!u.toString().includes('secret'), `${p.platform} leaks a secret into the auth URL`)
  }
})

test('OAuth state: sealed, single user, platform-bound, expiring', () => {
  const key = randomBytes(32)
  const now = 1_800_000_000_000
  const { url, cookie } = beginOAuth({ provider: SOCIAL_PROVIDERS.x, env: ENV, workspaceId: 'w', socialAccountId: 'a', userId: 'u1', key, now })
  const state = new URL(url).searchParams.get('state')
  assert.equal(new URL(url).searchParams.get('redirect_uri'), 'https://app.example.com/api/social/callback/x')
  assert.ok(!cookie.includes(state!), 'state is not readable from the cookie')
  const s = verifyOAuthState(cookie, { state, platform: 'x', userId: 'u1', key, now })
  assert.ok(s.verifier && s.verifier.length >= 43)
  assert.throws(() => verifyOAuthState(cookie, { state: 'forged', platform: 'x', userId: 'u1', key, now }), OAuthStateError)
  assert.throws(() => verifyOAuthState(cookie, { state, platform: 'tiktok', userId: 'u1', key, now }), OAuthStateError)
  assert.throws(() => verifyOAuthState(cookie, { state, platform: 'x', userId: 'someone-else', key, now }), OAuthStateError)
  assert.throws(() => verifyOAuthState(cookie, { state, platform: 'x', userId: 'u1', key, now: now + 11 * 60_000 }), OAuthStateError)
  assert.throws(() => verifyOAuthState(cookie, { state, platform: 'x', userId: 'u1', key: randomBytes(32), now }), OAuthStateError)
})

test('instagram: code exchange yields a long-lived token and user id', async () => {
  const { f, calls } = fakeFetch([
    ['api.instagram.com/oauth/access_token', () => ({ body: { access_token: 'short', user_id: 42, permissions: 'instagram_business_basic,instagram_business_content_publish' } })],
    ['graph.instagram.com/access_token', () => ({ body: { access_token: 'long', expires_in: 5_184_000 } })],
  ])
  const t = await SOCIAL_PROVIDERS.instagram.exchangeCode({ code: 'abc#_', redirectUri: 'https://app/cb' }, ENV, f)
  assert.equal(t.accessToken, 'long')
  assert.equal(t.accountRef, '42')
  assert.ok(t.expiresAt)
  assert.match(calls[0].body, /code=abc(&|$)/, 'the trailing #_ Instagram appends is stripped')
})

test('instagram: publish creates a container, waits, then publishes', async () => {
  let polls = 0
  const { f, calls } = fakeFetch([
    ['/media_publish', () => ({ body: { id: 'MEDIA1' } })],
    ['/17841400000/media', () => ({ body: { id: 'CONT1' } })],
    ['/CONT1?', () => ({ body: { status_code: ++polls < 2 ? 'IN_PROGRESS' : 'FINISHED' } })],
    ['/MEDIA1?', () => ({ body: { permalink: 'https://www.instagram.com/p/xyz/' } })],
  ])
  const ig = createInstagramProvider({ pollMs: 0 })
  const out = await ig.publish(TOKENS, post([{ kind: 'image', url: 'https://storage/x.jpg', mimeType: 'image/jpeg' }]), ENV, f)
  assert.equal(out.externalPostId, 'MEDIA1')
  assert.equal(out.url, 'https://www.instagram.com/p/xyz/')
  assert.match(calls[0].body, /image_url=/)
  assert.match(calls[0].body, /AI-generated/)
  await assert.rejects(ig.publish(TOKENS, post([]), ENV, f), UnsupportedPublishError)
})

test('provider errors never contain tokens and classify retryability', async () => {
  const { f } = fakeFetch([['graph.instagram.com', () => ({ status: 503, body: { error: { message: 'Service unavailable' } } })]])
  const err = await SOCIAL_PROVIDERS.instagram.fetchIdentity(TOKENS, f).catch(e => e)
  assert.ok(err instanceof SocialApiError)
  assert.equal(err.retryable, true)
  assert.ok(!err.message.includes('SECRET-ACCESS-TOKEN'), 'token leaked into error')
  const { f: f400 } = fakeFetch([['graph.instagram.com', () => ({ status: 400, body: { error: { message: 'Invalid parameter' } } })]])
  assert.equal((await SOCIAL_PROVIDERS.instagram.fetchIdentity(TOKENS, f400).catch(e => e)).retryable, false)
})

test('tiktok: posts are private by default, labelled AI-generated, and respect creator privacy options', async () => {
  const { f, calls } = fakeFetch([
    ['creator_info', () => ({ body: { data: { privacy_level_options: ['SELF_ONLY'] }, error: { code: 'ok' } } })],
    ['video/init', () => ({ body: { data: { publish_id: 'PUB1' }, error: { code: 'ok' } } })],
    ['status/fetch', () => ({ body: { data: { status: 'PUBLISH_COMPLETE' }, error: { code: 'ok' } } })],
  ])
  const tt = createTikTokProvider({ pollMs: 0 })
  const out = await tt.publish(TOKENS, post([{ kind: 'video', url: 'https://storage/v.mp4', mimeType: 'video/mp4' }], { isSponsored: true }), ENV, f)
  const init = JSON.parse(calls[1].body)
  assert.equal(init.post_info.privacy_level, 'SELF_ONLY')
  assert.equal(init.post_info.is_aigc, true)
  assert.equal(init.post_info.brand_content_toggle, true)
  assert.equal(out.url, null, 'private posts have no public URL')
  await assert.rejects(tt.publish(TOKENS, post([{ kind: 'video', url: 'https://s/v.mp4', mimeType: 'video/mp4' }]), { ...ENV, TIKTOK_PRIVACY_LEVEL: 'PUBLIC_TO_EVERYONE' }, f), /not available/)
})

test('youtube: resumable upload declares synthetic media and defaults to private', async () => {
  const { f, calls } = fakeFetch([
    ['storage/v.mp4', () => ({ raw: new Uint8Array([1, 2, 3]).buffer })],
    ['upload/youtube/v3/videos', () => ({ body: {}, headers: { location: 'https://www.googleapis.com/upload/session/abc' } })],
    ['upload/session/abc', () => ({ body: { id: 'VID1', status: { uploadStatus: 'uploaded' } } })],
  ])
  const out = await SOCIAL_PROVIDERS.youtube.publish(TOKENS, post([{ kind: 'video', url: 'https://storage/v.mp4', mimeType: 'video/mp4' }], { format: 'short', isSponsored: true }), ENV, f)
  const meta = JSON.parse(calls[1].body)
  assert.equal(meta.status.privacyStatus, 'private')
  assert.equal(meta.status.containsSyntheticMedia, true)
  assert.equal(meta.paidProductPlacementDetails.hasPaidProductPlacement, true)
  assert.match(calls[1].url, /part=snippet,status,paidProductPlacementDetails/)
  assert.equal(out.url, 'https://www.youtube.com/shorts/VID1')
  await assert.rejects(SOCIAL_PROVIDERS.youtube.publish(TOKENS, post([{ kind: 'image', url: 'https://s/i.jpg', mimeType: 'image/jpeg' }]), ENV, f), UnsupportedPublishError)
})

test('x: text post, confidential-client token exchange, video honestly unsupported', async () => {
  const { f, calls } = fakeFetch([
    ['oauth2/token', () => ({ body: { access_token: 'a', refresh_token: 'r', expires_in: 7200, scope: 'tweet.write users.read' } })],
    ['/2/tweets', () => ({ body: { data: { id: '999' } } })],
  ])
  const t = await SOCIAL_PROVIDERS.x.exchangeCode({ code: 'c', redirectUri: 'https://app/cb', codeVerifier: 'v' }, ENV, f)
  assert.equal(t.refreshToken, 'r')
  assert.match(calls[0].headers.authorization, /^Basic /)
  assert.match(calls[0].body, /code_verifier=v/)
  const out = await SOCIAL_PROVIDERS.x.publish(TOKENS, post([]), ENV, f)
  assert.equal(out.url, 'https://x.com/i/web/status/999')
  await assert.rejects(SOCIAL_PROVIDERS.x.publish(TOKENS, post([{ kind: 'video', url: 'https://s/v.mp4', mimeType: 'video/mp4' }]), ENV, f), UnsupportedPublishError)
})

const req = (method: string, url: string, headers: Record<string, string>, rawBody = '') => ({ method, url: new URL(url), headers: new Headers(headers), rawBody })

test('webhooks: signatures verified with real HMACs; forgeries rejected', () => {
  const body = JSON.stringify({ object: 'instagram', entry: [{ id: '1784', time: 1, changes: [{ field: 'comments', value: { id: 'C1', text: 'hi' } }] }] })
  const ig = SOCIAL_PROVIDERS.instagram
  const good = `sha256=${createHmac('sha256', 'meta-secret').update(body).digest('hex')}`
  assert.equal(ig.verifyWebhook!(req('POST', 'https://a/w', { 'x-hub-signature-256': good }, body), ENV), true)
  assert.equal(ig.verifyWebhook!(req('POST', 'https://a/w', { 'x-hub-signature-256': good }, body + ' '), ENV), false)
  assert.equal(ig.verifyWebhook!(req('POST', 'https://a/w', {}, body), ENV), false)
  assert.equal(ig.verifyWebhook!(req('POST', 'https://a/w', { 'x-hub-signature-256': good }, body), { ...ENV, META_APP_SECRET: undefined }), false, 'fails closed without a secret')
  assert.deepEqual(ig.parseWebhook!(JSON.parse(body)).map(e => e.eventId), ['comments:C1'])

  const hs = ig.webhookHandshake!(req('GET', 'https://a/w?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=123', {}), ENV)
  assert.deepEqual([hs?.status, hs?.body], [200, '123'])
  assert.equal(ig.webhookHandshake!(req('GET', 'https://a/w?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=123', {}), ENV)?.status, 403)

  const t = Math.floor(Date.now() / 1000)
  const ttBody = '{"event":"post.publish.complete","user_openid":"u","content":"{\\"publish_id\\":\\"P\\"}"}'
  const ttSig = createHmac('sha256', 'tt-secret').update(`${t}.${ttBody}`).digest('hex')
  const tt = SOCIAL_PROVIDERS.tiktok
  assert.equal(tt.verifyWebhook!(req('POST', 'https://a/w', { 'tiktok-signature': `t=${t},s=${ttSig}` }, ttBody), ENV), true)
  assert.equal(tt.verifyWebhook!(req('POST', 'https://a/w', { 'tiktok-signature': `t=${t - 3600},s=${createHmac('sha256', 'tt-secret').update(`${t - 3600}.${ttBody}`).digest('hex')}` }, ttBody), ENV), false, 'replayed (old) signatures rejected')

  const x = SOCIAL_PROVIDERS.x
  const crc = x.webhookHandshake!(req('GET', 'https://a/w?crc_token=abc', {}), ENV)
  assert.equal(JSON.parse(crc!.body).response_token, `sha256=${createHmac('sha256', 'x-consumer').update('abc').digest('base64')}`)
  const xBody = '{"for_user_id":"1","tweet_create_events":[{"id_str":"5","text":"@nova hi"}]}'
  assert.equal(x.verifyWebhook!(req('POST', 'https://a/w', { 'x-twitter-webhooks-signature': `sha256=${createHmac('sha256', 'x-consumer').update(xBody).digest('base64')}` }, xBody), ENV), true)
  assert.equal(x.verifyWebhook!(req('POST', 'https://a/w', { 'x-twitter-webhooks-signature': 'sha256=forged' }, xBody), ENV), false)
})

test('token refresh window', () => {
  const now = Date.now()
  assert.equal(needsRefresh({ accessToken: 'a', scopes: [], expiresAt: new Date(now + 60_000).toISOString() }, now), true)
  assert.equal(needsRefresh({ accessToken: 'a', scopes: [], expiresAt: new Date(now + 3_600_000).toISOString() }, now), false)
  assert.equal(needsRefresh({ accessToken: 'a', scopes: [] }, now), false)
})
