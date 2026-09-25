import type { Env, OAuthTokens, SocialProvider } from './types'
import { FORM_HEADERS, SocialApiError, UnsupportedPublishError, bearer, expiresAt, form, requestJson } from './http'
import type { ApiJson } from './http'

/**
 * YouTube via Google OAuth 2.0 (PKCE) + YouTube Data API v3 resumable upload.
 * Uploads from unverified Google Cloud projects are forced private by YouTube;
 * YOUTUBE_PRIVACY_STATUS defaults to 'private'. Every upload declares
 * containsSyntheticMedia (AI content) and paid product placement when sponsored.
 * Env: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, YOUTUBE_PRIVACY_STATUS.
 */

const P = 'youtube'
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/youtube.force-ssl',
]

function creds(env: Env) {
  const id = env.GOOGLE_OAUTH_CLIENT_ID, secret = env.GOOGLE_OAUTH_CLIENT_SECRET
  if (!id || !secret) throw new SocialApiError(P, 0, 'GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET not configured', false)
  return { id, secret }
}

function toTokens(r: ApiJson, prev?: OAuthTokens): OAuthTokens {
  return {
    accessToken: r.access_token, refreshToken: r.refresh_token ?? prev?.refreshToken, expiresAt: expiresAt(r.expires_in),
    scopes: r.scope ? String(r.scope).split(' ') : prev?.scopes ?? [], accountRef: prev?.accountRef,
  }
}

export function createYouTubeProvider(): SocialProvider {
  return {
    platform: P, displayName: 'YouTube', integrationId: 'youtube', scopes: SCOPES, usesPkce: true,
    capabilities: { publishImage: false, publishVideo: true, publishText: false, metrics: true, webhooks: false, replyToComments: true, ageRestriction: false },
    requirements: [
      'Google Cloud project with the YouTube Data API v3 enabled and an OAuth consent screen.',
      'Unverified projects can only upload private videos; YOUTUBE_PRIVACY_STATUS stays "private" until Google completes the API audit.',
      'Default quota (10,000 units/day) allows about six uploads per day.',
      'Uploads are declared as containing synthetic (AI-generated) media.',
    ],
    configured: env => Boolean(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET),

    authorizationUrl({ state, redirectUri, codeChallenge }, env) {
      const u = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      u.search = new URLSearchParams({
        client_id: creds(env).id, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES.join(' '),
        access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
        ...(codeChallenge ? { code_challenge: codeChallenge, code_challenge_method: 'S256' } : {}),
      }).toString()
      return u.toString()
    },

    async exchangeCode({ code, redirectUri, codeVerifier }, env, f) {
      const c = creds(env)
      return toTokens(await requestJson(f, P, 'https://oauth2.googleapis.com/token', {
        method: 'POST', headers: FORM_HEADERS,
        body: form({ client_id: c.id, client_secret: c.secret, code, grant_type: 'authorization_code', redirect_uri: redirectUri, ...(codeVerifier ? { code_verifier: codeVerifier } : {}) }),
      }))
    },

    async refresh(t, env, f) {
      if (!t.refreshToken) throw new SocialApiError(P, 0, 'no refresh token; reconnect the account', false)
      const c = creds(env)
      return toTokens(await requestJson(f, P, 'https://oauth2.googleapis.com/token', {
        method: 'POST', headers: FORM_HEADERS, body: form({ client_id: c.id, client_secret: c.secret, grant_type: 'refresh_token', refresh_token: t.refreshToken }),
      }), t)
    },

    async fetchIdentity(t, f) {
      const r = await requestJson(f, P, 'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: bearer(t.accessToken) })
      const ch = r.items?.[0]
      if (!ch) throw new SocialApiError(P, 404, 'this Google account has no YouTube channel', false)
      return { externalAccountId: ch.id, handle: ch.snippet?.customUrl ?? null, displayName: ch.snippet?.title ?? null }
    },

    async publish(t, input, env, f) {
      const video = input.media.find(m => m.kind === 'video')
      if (!video || input.media.length !== 1) throw new UnsupportedPublishError(P, 'anything other than a single video')
      const privacyStatus = env.YOUTUBE_PRIVACY_STATUS || 'private'
      const media = await f(video.url)
      if (!media.ok) throw new SocialApiError(P, media.status, 'could not read the video from storage', media.status >= 500)
      const bytes = new Uint8Array(await media.arrayBuffer())

      const parts = ['snippet', 'status', ...(input.isSponsored ? ['paidProductPlacementDetails'] : [])]
      const metadata = {
        snippet: { title: (input.title ?? input.caption.split('\n')[0]).slice(0, 100), description: input.caption.slice(0, 5000), categoryId: '22' },
        status: { privacyStatus, selfDeclaredMadeForKids: false, containsSyntheticMedia: true },
        ...(input.isSponsored ? { paidProductPlacementDetails: { hasPaidProductPlacement: true } } : {}),
      }
      let session: Response
      try {
        session = await f(`https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=${parts.join(',')}`, {
          method: 'POST',
          headers: bearer(t.accessToken, { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': video.mimeType, 'X-Upload-Content-Length': String(bytes.byteLength) }),
          body: JSON.stringify(metadata),
        })
      } catch (e) { throw new SocialApiError(P, 0, `network error starting upload: ${(e as Error).message}`, true) }
      if (!session.ok) throw new SocialApiError(P, session.status, `upload session failed (${session.status})`, session.status === 429 || session.status >= 500)
      const location = session.headers.get('location')
      if (!location) throw new SocialApiError(P, 0, 'no upload session URL returned', true)

      const done = await requestJson(f, P, location, { method: 'PUT', headers: { 'Content-Type': video.mimeType, 'Content-Length': String(bytes.byteLength) }, body: bytes })
      const isShort = input.format === 'short'
      return { externalPostId: done.id, url: `https://www.youtube.com/${isShort ? `shorts/${done.id}` : `watch?v=${done.id}`}`, summary: { videoId: done.id, privacyStatus, uploadStatus: done.status?.uploadStatus } }
    },

    async fetchPostMetrics(t, id, f) {
      const r = await requestJson(f, P, `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${encodeURIComponent(id)}`, { headers: bearer(t.accessToken) })
      const s = r.items?.[0]?.statistics ?? {}
      const n = (v: unknown) => (v === undefined ? undefined : Number(v))
      return { views: n(s.viewCount), likes: n(s.likeCount), comments: n(s.commentCount) }
    },

    async replyToComment(t, commentId, text, f) {
      const r = await requestJson(f, P, 'https://www.googleapis.com/youtube/v3/comments?part=snippet', {
        method: 'POST', headers: bearer(t.accessToken, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ snippet: { parentId: commentId, textOriginal: text } }),
      })
      return { externalId: String(r.id) }
    },
  }
}
