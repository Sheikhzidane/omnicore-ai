import type { Env, OAuthTokens, SocialProvider } from './types'
import { FORM_HEADERS, SocialApiError, UnsupportedPublishError, expiresAt, form, hmacHex, requestJson, safeEqual, sleep } from './http'
import type { ApiJson } from './http'

/**
 * Instagram via the Instagram API with Instagram Login (graph.instagram.com).
 * Requires a Professional (Business/Creator) account and a Meta app with the
 * instagram_business_* permissions approved through App Review.
 * Env: META_APP_ID, META_APP_SECRET, META_WEBHOOK_VERIFY_TOKEN (webhooks).
 */

const GRAPH = 'https://graph.instagram.com/v23.0'
const P = 'instagram'
const SCOPES = ['instagram_business_basic', 'instagram_business_content_publish', 'instagram_business_manage_comments', 'instagram_business_manage_insights']

function creds(env: Env) {
  const id = env.META_APP_ID, secret = env.META_APP_SECRET
  if (!id || !secret) throw new SocialApiError(P, 0, 'META_APP_ID / META_APP_SECRET not configured', false)
  return { id, secret }
}

export function createInstagramProvider(opts: { pollMs?: number; maxPolls?: number } = {}): SocialProvider {
  const pollMs = opts.pollMs ?? 5000, maxPolls = opts.maxPolls ?? 10
  const q = (t: OAuthTokens, extra: Record<string, string> = {}) => new URLSearchParams({ ...extra, access_token: t.accessToken }).toString()
  const userId = (t: OAuthTokens) => { if (!t.accountRef) throw new SocialApiError(P, 0, 'missing Instagram user id', false); return t.accountRef }

  return {
    platform: P, displayName: 'Instagram', integrationId: 'meta', scopes: SCOPES, usesPkce: false,
    capabilities: { publishImage: true, publishVideo: true, publishText: false, metrics: true, webhooks: true, replyToComments: true, ageRestriction: false },
    requirements: [
      'Instagram Professional (Business or Creator) account.',
      'Meta app with Instagram API (Instagram Login) and App Review approval for instagram_business_content_publish.',
      'Media must be at a public HTTPS URL Meta can fetch (signed Storage URLs are used).',
      'Instagram limits accounts to 100 API-published posts per 24 hours.',
    ],
    configured: env => Boolean(env.META_APP_ID && env.META_APP_SECRET),

    authorizationUrl({ state, redirectUri }, env) {
      const u = new URL('https://www.instagram.com/oauth/authorize')
      u.search = new URLSearchParams({ client_id: creds(env).id, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES.join(','), state }).toString()
      return u.toString()
    },

    async exchangeCode({ code, redirectUri }, env, f) {
      const c = creds(env)
      const short = await requestJson(f, P, 'https://api.instagram.com/oauth/access_token', {
        method: 'POST', headers: FORM_HEADERS,
        body: form({ client_id: c.id, client_secret: c.secret, grant_type: 'authorization_code', redirect_uri: redirectUri, code: code.replace(/#_$/, '') }),
      })
      // Swap the 1-hour token for a 60-day long-lived token.
      const long = await requestJson(f, P, `${GRAPH.replace('/v23.0', '')}/access_token?${new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: c.secret, access_token: short.access_token })}`)
      const scopes = Array.isArray(short.permissions) ? short.permissions : String(short.permissions ?? '').split(',').filter(Boolean)
      return { accessToken: long.access_token, expiresAt: expiresAt(long.expires_in), scopes, accountRef: String(short.user_id) }
    },

    async refresh(t, _env, f) {
      const r = await requestJson(f, P, `https://graph.instagram.com/refresh_access_token?${new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: t.accessToken })}`)
      return { ...t, accessToken: r.access_token, expiresAt: expiresAt(r.expires_in) }
    },

    async fetchIdentity(t, f) {
      const me = await requestJson(f, P, `${GRAPH}/me?${q(t, { fields: 'user_id,username,name' })}`)
      return { externalAccountId: String(me.user_id ?? me.id), handle: me.username ?? null, displayName: me.name ?? null }
    },

    async publish(t, input, _env, f) {
      const uid = userId(t)
      if (input.media.length !== 1) throw new UnsupportedPublishError(P, input.media.length === 0 ? 'a post without media' : 'carousel publishing')
      const m = input.media[0]
      const params: Record<string, string> = m.kind === 'image'
        ? { image_url: m.url, caption: input.caption }
        : { media_type: 'REELS', video_url: m.url, caption: input.caption }
      const container = await requestJson(f, P, `${GRAPH}/${uid}/media`, { method: 'POST', headers: FORM_HEADERS, body: form({ ...params, access_token: t.accessToken }) })

      // Containers must finish processing before publish.
      for (let i = 0; ; i++) {
        const s = await requestJson(f, P, `${GRAPH}/${container.id}?${q(t, { fields: 'status_code' })}`)
        if (s.status_code === 'FINISHED') break
        if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new SocialApiError(P, 0, `media container ${s.status_code}`, false)
        if (i >= maxPolls) throw new SocialApiError(P, 0, 'media container still processing; will retry', true)
        await sleep(pollMs)
      }
      const pub = await requestJson(f, P, `${GRAPH}/${uid}/media_publish`, { method: 'POST', headers: FORM_HEADERS, body: form({ creation_id: container.id, access_token: t.accessToken }) })
      let url: string | null = null
      try { url = (await requestJson(f, P, `${GRAPH}/${pub.id}?${q(t, { fields: 'permalink' })}`)).permalink ?? null } catch { /* permalink is best effort */ }
      return { externalPostId: String(pub.id), url, summary: { containerId: container.id, mediaId: pub.id } }
    },

    async fetchPostMetrics(t, id, f) {
      const r = await requestJson(f, P, `${GRAPH}/${id}/insights?${q(t, { metric: 'reach,likes,comments,shares,saved,views' })}`)
      const val = (name: string) => r.data?.find((d: ApiJson) => d.name === name)?.values?.[0]?.value
      return { reach: val('reach'), likes: val('likes'), comments: val('comments'), shares: val('shares'), saves: val('saved'), views: val('views') }
    },

    async replyToComment(t, commentId, text, f) {
      const r = await requestJson(f, P, `${GRAPH}/${commentId}/replies`, { method: 'POST', headers: FORM_HEADERS, body: form({ message: text, access_token: t.accessToken }) })
      return { externalId: String(r.id) }
    },

    webhookHandshake(req, env) {
      if (req.method !== 'GET') return null
      const p = req.url.searchParams
      const expected = env.META_WEBHOOK_VERIFY_TOKEN
      if (p.get('hub.mode') === 'subscribe' && expected && safeEqual(p.get('hub.verify_token') ?? '', expected)) {
        return { status: 200, body: p.get('hub.challenge') ?? '', contentType: 'text/plain' }
      }
      return { status: 403, body: 'forbidden' }
    },

    verifyWebhook(req, env) {
      const secret = env.META_APP_SECRET
      const sig = req.headers.get('x-hub-signature-256') ?? ''
      return Boolean(secret) && sig.startsWith('sha256=') && safeEqual(sig, `sha256=${hmacHex(secret!, req.rawBody)}`)
    },

    parseWebhook(body) {
      const b = body as { object?: string; entry?: { id: string; time: number; changes?: { field: string; value: Record<string, unknown> }[] }[] }
      const out = []
      for (const e of b.entry ?? []) for (const c of e.changes ?? []) {
        const v = c.value ?? {}
        const id = String(v.id ?? v.comment_id ?? v.media_id ?? `${e.id}:${c.field}:${e.time}`)
        out.push({ eventId: `${c.field}:${id}`, eventType: c.field, externalAccountId: String(e.id), payload: v })
      }
      return out
    },
  }
}
