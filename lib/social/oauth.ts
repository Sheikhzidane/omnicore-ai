import 'server-only'
import { randomBytes } from 'node:crypto'
import { decryptSecret, encryptSecret } from '@/lib/secrets/credentials'
import { pkcePair, safeEqual } from './providers/http'
import type { Env, SocialProvider } from './providers/types'

/**
 * OAuth connect flow state. The state value, PKCE verifier and the
 * (workspace, account, user) being connected are sealed with the credential
 * vault key (AES-256-GCM) into a short-lived httpOnly cookie. The callback
 * accepts the code only if the query `state` matches the sealed one, the
 * cookie is unexpired, and the signed-in user is the one who started the flow.
 */

export const OAUTH_COOKIE = 'omnicore_oauth'
export const OAUTH_TTL_SECONDS = 600

export interface OAuthState {
  state: string
  verifier?: string
  platform: string
  workspaceId: string
  socialAccountId: string
  userId: string
  exp: number
}

export function redirectUriFor(platform: string, env: Env): string {
  const base = env.NEXT_PUBLIC_SITE_URL
  if (!base) throw new Error('NEXT_PUBLIC_SITE_URL must be set for OAuth redirects')
  return `${base.replace(/\/+$/, '')}/api/social/callback/${platform}`
}

export function beginOAuth(p: { provider: SocialProvider; env: Env; workspaceId: string; socialAccountId: string; userId: string; key?: Buffer; now?: number }) {
  const state = randomBytes(24).toString('base64url')
  const pkce = p.provider.usesPkce ? pkcePair() : null
  const payload: OAuthState = {
    state, verifier: pkce?.verifier, platform: p.provider.platform, workspaceId: p.workspaceId,
    socialAccountId: p.socialAccountId, userId: p.userId, exp: Math.floor((p.now ?? Date.now()) / 1000) + OAUTH_TTL_SECONDS,
  }
  const url = p.provider.authorizationUrl({ state, redirectUri: redirectUriFor(p.provider.platform, p.env), codeChallenge: pkce?.challenge }, p.env)
  return { url, cookie: encryptSecret(JSON.stringify(payload), ...(p.key ? [p.key] as const : [])) }
}

export class OAuthStateError extends Error {
  constructor(reason: string) { super(`OAuth state rejected: ${reason}`); this.name = 'OAuthStateError' }
}

export function verifyOAuthState(cookie: string | undefined, q: { state: string | null; platform: string; userId: string; now?: number; key?: Buffer }): OAuthState {
  if (!cookie) throw new OAuthStateError('missing cookie')
  let s: OAuthState
  try { s = JSON.parse(decryptSecret(cookie, ...(q.key ? [q.key] as const : []))) } catch { throw new OAuthStateError('cookie could not be decrypted') }
  if (!q.state || !safeEqual(q.state, s.state)) throw new OAuthStateError('state mismatch')
  if (s.platform !== q.platform) throw new OAuthStateError('platform mismatch')
  if (s.userId !== q.userId) throw new OAuthStateError('different user')
  if (s.exp < Math.floor((q.now ?? Date.now()) / 1000)) throw new OAuthStateError('expired')
  return s
}
