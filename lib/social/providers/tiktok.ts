import type { Env, OAuthTokens, SocialProvider } from './types'
import { FORM_HEADERS, SocialApiError, UnsupportedPublishError, bearer, expiresAt, form, hmacHex, requestJson, safeEqual, sleep } from './http'
import type { ApiJson } from './http'

/**
 * TikTok via Login Kit + the Content Posting API (Direct Post).
 * Unaudited apps can only post privately (SELF_ONLY) — TIKTOK_PRIVACY_LEVEL
 * defaults to SELF_ONLY and must only be changed after TikTok's app audit.
 * PULL_FROM_URL requires the media domain to be verified in the TikTok app.
 * Env: TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, TIKTOK_PRIVACY_LEVEL.
 */

const API = 'https://open.tiktokapis.com/v2'
const P = 'tiktok'
const SCOPES = ['user.info.basic', 'video.publish', 'video.list']

function creds(env: Env) {
  const key = env.TIKTOK_CLIENT_KEY, secret = env.TIKTOK_CLIENT_SECRET
  if (!key || !secret) throw new SocialApiError(P, 0, 'TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET not configured', false)
  return { key, secret }
}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' }

function toTokens(r: ApiJson): OAuthTokens {
  if (r.error && r.error !== 'ok') throw new SocialApiError(P, 400, String(r.error_description ?? r.error), false)
  return {
    accessToken: r.access_token, refreshToken: r.refresh_token, expiresAt: expiresAt(r.expires_in),
    refreshExpiresAt: expiresAt(r.refresh_expires_in), scopes: String(r.scope ?? '').split(',').filter(Boolean), accountRef: r.open_id,
  }
}

function check(r: ApiJson) {
  if (r?.error?.code && r.error.code !== 'ok') throw new SocialApiError(P, 400, `${r.error.code}: ${String(r.error.message ?? '').slice(0, 200)}`, r.error.code === 'rate_limit_exceeded')
  return r
}

export function createTikTokProvider(opts: { pollMs?: number; maxPolls?: number } = {}): SocialProvider {
  const pollMs = opts.pollMs ?? 5000, maxPolls = opts.maxPolls ?? 10
  return {
    platform: P, displayName: 'TikTok', integrationId: 'tiktok', scopes: SCOPES, usesPkce: false,
    capabilities: { publishImage: true, publishVideo: true, publishText: false, metrics: true, webhooks: true, replyToComments: false, ageRestriction: false },
    requirements: [
      'TikTok developer app with Login Kit and the Content Posting API (Direct Post) enabled.',
      'Until TikTok audits the app, posts are private (SELF_ONLY); TIKTOK_PRIVACY_LEVEL stays SELF_ONLY until then.',
      'The Supabase Storage domain must be verified in the TikTok app for PULL_FROM_URL uploads.',
      'Every post is labelled as AI-generated content (is_aigc).',
    ],
    configured: env => Boolean(env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET),

    authorizationUrl({ state, redirectUri }, env) {
      const u = new URL('https://www.tiktok.com/v2/auth/authorize/')
      u.search = new URLSearchParams({ client_key: creds(env).key, scope: SCOPES.join(','), response_type: 'code', redirect_uri: redirectUri, state }).toString()
      return u.toString()
    },

    async exchangeCode({ code, redirectUri }, env, f) {
      const c = creds(env)
      return toTokens(await requestJson(f, P, `${API}/oauth/token/`, {
        method: 'POST', headers: FORM_HEADERS,
        body: form({ client_key: c.key, client_secret: c.secret, code, grant_type: 'authorization_code', redirect_uri: redirectUri }),
      }))
    },

    async refresh(t, env, f) {
      if (!t.refreshToken) throw new SocialApiError(P, 0, 'no refresh token; reconnect the account', false)
      const c = creds(env)
      return toTokens(await requestJson(f, P, `${API}/oauth/token/`, {
        method: 'POST', headers: FORM_HEADERS,
        body: form({ client_key: c.key, client_secret: c.secret, grant_type: 'refresh_token', refresh_token: t.refreshToken }),
      }))
    },

    async fetchIdentity(t, f) {
      const r = check(await requestJson(f, P, `${API}/user/info/?fields=open_id,display_name,username`, { headers: bearer(t.accessToken) }))
      const u = r.data?.user ?? {}
      return { externalAccountId: String(u.open_id ?? t.accountRef), handle: u.username ?? null, displayName: u.display_name ?? null }
    },

    async publish(t, input, env, f) {
      if (input.media.length === 0) throw new UnsupportedPublishError(P, 'a post without media')
      const privacy = env.TIKTOK_PRIVACY_LEVEL || 'SELF_ONLY'
      const creator = check(await requestJson(f, P, `${API}/post/publish/creator_info/query/`, { method: 'POST', headers: bearer(t.accessToken, JSON_HEADERS) }))
      const options: string[] = creator.data?.privacy_level_options ?? []
      if (!options.includes(privacy)) throw new SocialApiError(P, 400, `privacy level ${privacy} is not available for this account (allowed: ${options.join(', ') || 'none'})`, false)

      const postInfo = {
        title: input.caption.slice(0, input.media[0].kind === 'video' ? 2200 : 90),
        privacy_level: privacy, disable_comment: false, is_aigc: true,
        brand_content_toggle: input.isSponsored, brand_organic_toggle: false,
      }
      let init
      if (input.media.every(m => m.kind === 'image')) {
        init = check(await requestJson(f, P, `${API}/post/publish/content/init/`, {
          method: 'POST', headers: bearer(t.accessToken, JSON_HEADERS),
          body: JSON.stringify({
            post_info: { ...postInfo, description: input.caption.slice(0, 4000) }, post_mode: 'DIRECT_POST', media_type: 'PHOTO',
            source_info: { source: 'PULL_FROM_URL', photo_images: input.media.slice(0, 35).map(m => m.url), photo_cover_index: 0 },
          }),
        }))
      } else if (input.media.length === 1) {
        init = check(await requestJson(f, P, `${API}/post/publish/video/init/`, {
          method: 'POST', headers: bearer(t.accessToken, JSON_HEADERS),
          body: JSON.stringify({ post_info: postInfo, source_info: { source: 'PULL_FROM_URL', video_url: input.media[0].url } }),
        }))
      } else {
        throw new UnsupportedPublishError(P, 'mixing video with other media')
      }
      const publishId = init.data?.publish_id
      if (!publishId) throw new SocialApiError(P, 0, 'no publish_id returned', true)

      for (let i = 0; ; i++) {
        const s = check(await requestJson(f, P, `${API}/post/publish/status/fetch/`, { method: 'POST', headers: bearer(t.accessToken, JSON_HEADERS), body: JSON.stringify({ publish_id: publishId }) }))
        const status = s.data?.status
        if (status === 'PUBLISH_COMPLETE') {
          const postId = s.data?.publicaly_available_post_id?.[0] ?? s.data?.publicly_available_post_id?.[0]
          // Private (SELF_ONLY) posts have no public id or URL.
          return { externalPostId: String(postId ?? publishId), url: null, summary: { publishId, status, privacy } }
        }
        if (status === 'FAILED') throw new SocialApiError(P, 0, `publish failed: ${String(s.data?.fail_reason ?? 'unknown')}`, false)
        if (i >= maxPolls) throw new SocialApiError(P, 0, `still processing (publish_id ${publishId}); will retry`, true)
        await sleep(pollMs)
      }
    },

    async fetchPostMetrics(t, id, f) {
      const r = check(await requestJson(f, P, `${API}/video/query/?fields=id,view_count,like_count,comment_count,share_count`, {
        method: 'POST', headers: bearer(t.accessToken, JSON_HEADERS), body: JSON.stringify({ filters: { video_ids: [id] } }),
      }))
      const v = r.data?.videos?.[0] ?? {}
      return { views: v.view_count, likes: v.like_count, comments: v.comment_count, shares: v.share_count }
    },

    verifyWebhook(req, env) {
      // TikTok-Signature: t=<unix>,s=<hex hmac of "t.body" with the client secret>
      const secret = env.TIKTOK_CLIENT_SECRET
      const header = req.headers.get('tiktok-signature') ?? ''
      const parts = Object.fromEntries(header.split(',').map(p => p.split('=') as [string, string]))
      if (!secret || !parts.t || !parts.s) return false
      if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false
      return safeEqual(parts.s, hmacHex(secret, `${parts.t}.${req.rawBody}`))
    },

    parseWebhook(body) {
      const b = body as { event?: string; create_time?: number; user_openid?: string; content?: string }
      if (!b.event) return []
      let content: Record<string, unknown> = {}
      try { content = typeof b.content === 'string' ? JSON.parse(b.content) : {} } catch { /* ignore */ }
      const ref = String(content.publish_id ?? content.video_id ?? b.create_time ?? '')
      return [{ eventId: `${b.event}:${b.user_openid ?? ''}:${ref}`, eventType: b.event, externalAccountId: b.user_openid, payload: content }]
    },
  }
}
