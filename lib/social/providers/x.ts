import type { Env, OAuthTokens, SocialProvider } from './types'
import { FORM_HEADERS, SocialApiError, UnsupportedPublishError, bearer, expiresAt, form, hmacBase64, requestJson, safeEqual } from './http'
import type { ApiJson } from './http'

/**
 * X via OAuth 2.0 Authorization Code with PKCE and the v2 API.
 * Text posts and single-image posts (v2 media upload). Video upload needs the
 * chunked upload flow and is not implemented. Write access depends on the
 * X API access tier. Webhooks (Account Activity API) need X_CONSUMER_SECRET.
 * Env: X_CLIENT_ID, X_CLIENT_SECRET, X_CONSUMER_SECRET (webhooks only).
 */

const API = 'https://api.x.com/2'
const P = 'x'
const SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'offline.access', 'media.write']

function creds(env: Env) {
  const id = env.X_CLIENT_ID, secret = env.X_CLIENT_SECRET
  if (!id || !secret) throw new SocialApiError(P, 0, 'X_CLIENT_ID / X_CLIENT_SECRET not configured', false)
  return { id, secret, basic: `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}` }
}

function toTokens(r: ApiJson, prev?: OAuthTokens): OAuthTokens {
  return { accessToken: r.access_token, refreshToken: r.refresh_token ?? prev?.refreshToken, expiresAt: expiresAt(r.expires_in), scopes: String(r.scope ?? '').split(' ').filter(Boolean), accountRef: prev?.accountRef }
}

export function createXProvider(): SocialProvider {
  return {
    platform: P, displayName: 'X', integrationId: 'x', scopes: SCOPES, usesPkce: true,
    capabilities: { publishImage: true, publishVideo: false, publishText: true, metrics: true, webhooks: true, replyToComments: true, ageRestriction: false },
    requirements: [
      'X developer project with an app using OAuth 2.0 (confidential client).',
      'Posting requires an API access tier with write access; limits depend on the tier.',
      'Video posts are not supported by this integration yet (text and single images only).',
    ],
    configured: env => Boolean(env.X_CLIENT_ID && env.X_CLIENT_SECRET),

    authorizationUrl({ state, redirectUri, codeChallenge }, env) {
      if (!codeChallenge) throw new Error('X requires PKCE')
      const u = new URL('https://x.com/i/oauth2/authorize')
      u.search = new URLSearchParams({ response_type: 'code', client_id: creds(env).id, redirect_uri: redirectUri, scope: SCOPES.join(' '), state, code_challenge: codeChallenge, code_challenge_method: 'S256' }).toString()
      return u.toString()
    },

    async exchangeCode({ code, redirectUri, codeVerifier }, env, f) {
      const c = creds(env)
      return toTokens(await requestJson(f, P, `${API}/oauth2/token`, {
        method: 'POST', headers: { ...FORM_HEADERS, Authorization: c.basic },
        body: form({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: codeVerifier ?? '' }),
      }))
    },

    async refresh(t, env, f) {
      if (!t.refreshToken) throw new SocialApiError(P, 0, 'no refresh token; reconnect the account', false)
      const c = creds(env)
      return toTokens(await requestJson(f, P, `${API}/oauth2/token`, {
        method: 'POST', headers: { ...FORM_HEADERS, Authorization: c.basic }, body: form({ grant_type: 'refresh_token', refresh_token: t.refreshToken }),
      }), t)
    },

    async fetchIdentity(t, f) {
      const r = await requestJson(f, P, `${API}/users/me`, { headers: bearer(t.accessToken) })
      return { externalAccountId: String(r.data.id), handle: r.data.username ?? null, displayName: r.data.name ?? null }
    },

    async publish(t, input, _env, f) {
      if (input.media.some(m => m.kind === 'video')) throw new UnsupportedPublishError(P, 'video upload')
      if (input.media.length > 1) throw new UnsupportedPublishError(P, 'multiple images')
      const mediaIds: string[] = []
      for (const m of input.media) {
        const file = await f(m.url)
        if (!file.ok) throw new SocialApiError(P, file.status, 'could not read the image from storage', file.status >= 500)
        const fd = new FormData()
        fd.set('media', new Blob([await file.arrayBuffer()], { type: m.mimeType }))
        fd.set('media_category', 'tweet_image')
        const up = await requestJson(f, P, `${API}/media/upload`, { method: 'POST', headers: bearer(t.accessToken), body: fd })
        mediaIds.push(String(up.data?.id ?? up.media_id_string))
      }
      const body: Record<string, unknown> = { text: input.caption }
      if (mediaIds.length) body.media = { media_ids: mediaIds }
      const r = await requestJson(f, P, `${API}/tweets`, { method: 'POST', headers: bearer(t.accessToken, { 'Content-Type': 'application/json' }), body: JSON.stringify(body) })
      const id = String(r.data.id)
      return { externalPostId: id, url: `https://x.com/i/web/status/${id}`, summary: { tweetId: id, mediaCount: mediaIds.length } }
    },

    async fetchPostMetrics(t, id, f) {
      const r = await requestJson(f, P, `${API}/tweets/${encodeURIComponent(id)}?tweet.fields=public_metrics`, { headers: bearer(t.accessToken) })
      const m = r.data?.public_metrics ?? {}
      return { impressions: m.impression_count, likes: m.like_count, comments: m.reply_count, shares: (m.retweet_count ?? 0) + (m.quote_count ?? 0), saves: m.bookmark_count }
    },

    async replyToComment(t, tweetId, text, f) {
      const r = await requestJson(f, P, `${API}/tweets`, {
        method: 'POST', headers: bearer(t.accessToken, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ text, reply: { in_reply_to_tweet_id: tweetId } }),
      })
      return { externalId: String(r.data.id) }
    },

    webhookHandshake(req, env) {
      // Account Activity API CRC: GET ?crc_token=… → {"response_token":"sha256=<b64 hmac>"}
      const crc = req.method === 'GET' ? req.url.searchParams.get('crc_token') : null
      if (!crc) return null
      if (!env.X_CONSUMER_SECRET) return { status: 503, body: 'webhooks not configured' }
      return { status: 200, body: JSON.stringify({ response_token: `sha256=${hmacBase64(env.X_CONSUMER_SECRET, crc)}` }), contentType: 'application/json' }
    },

    verifyWebhook(req, env) {
      const secret = env.X_CONSUMER_SECRET
      const sig = req.headers.get('x-twitter-webhooks-signature') ?? ''
      return Boolean(secret) && safeEqual(sig, `sha256=${hmacBase64(secret!, req.rawBody)}`)
    },

    parseWebhook(body) {
      const b = body as { for_user_id?: string; tweet_create_events?: { id_str: string; in_reply_to_status_id_str?: string; text?: string; user?: { screen_name?: string; id_str?: string } }[] }
      return (b.tweet_create_events ?? []).map(e => ({
        eventId: `tweet_create:${e.id_str}`, eventType: 'tweet_create', externalAccountId: b.for_user_id,
        payload: { id: e.id_str, inReplyTo: e.in_reply_to_status_id_str ?? null, text: e.text ?? '', author: e.user?.screen_name ?? null, authorId: e.user?.id_str ?? null },
      }))
    },
  }
}
