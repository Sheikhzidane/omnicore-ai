import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { decryptSecret, encryptSecret } from '@/lib/secrets/credentials'
import type { Env, FetchFn, OAuthTokens, SocialProvider } from './providers/types'

type Db = SupabaseClient<Database>

/**
 * Social token storage. The token bundle is encrypted in the app
 * (lib/secrets/credentials.ts) and stored through the service-role-only
 * store_social_credential() RPC into private.social_credential_secrets.
 * Only non-secret metadata (scopes, expiry, status) lives in public tables.
 */

export async function storeTokens(db: Db, workspaceId: string, socialAccountId: string, tokens: OAuthTokens, key?: Buffer) {
  const ciphertext = encryptSecret(JSON.stringify(tokens), ...(key ? [key] as const : []))
  const s = await db.rpc('store_social_credential', { p_social_account_id: socialAccountId, p_ciphertext: ciphertext })
  if (s.error) throw new Error(`store credential: ${s.error.message}`)
  const meta = {
    workspace_id: workspaceId, social_account_id: socialAccountId, token_type: 'oauth2' as const, scopes: tokens.scopes,
    expires_at: tokens.expiresAt ?? null, refresh_expires_at: tokens.refreshExpiresAt ?? null, key_version: ciphertext.split('.')[0],
    last_refreshed_at: new Date().toISOString(), status: 'valid' as const,
  }
  const m = await db.from('social_credentials_metadata').upsert(meta, { onConflict: 'social_account_id' })
  if (m.error) throw new Error(`credential metadata: ${m.error.message}`)
}

export class ReconnectRequiredError extends Error {
  constructor(msg: string) { super(msg); this.name = 'ReconnectRequiredError' }
}

/** Needs refreshing if it expires within five minutes. */
export const needsRefresh = (t: OAuthTokens, now = Date.now()) => Boolean(t.expiresAt && Date.parse(t.expiresAt) - now < 5 * 60_000)

/** Loads (and if needed refreshes + re-stores) the tokens for an account. Server-only; never return these to a client. */
export async function loadTokens(db: Db, p: { workspaceId: string; socialAccountId: string; provider: SocialProvider; env: Env; fetch: FetchFn; key?: Buffer }): Promise<OAuthTokens> {
  const r = await db.rpc('read_social_credential', { p_social_account_id: p.socialAccountId })
  if (r.error) throw new Error(`read credential: ${r.error.message}`)
  if (!r.data) throw new ReconnectRequiredError('no stored credential; connect the account')
  let tokens = JSON.parse(decryptSecret(r.data, ...(p.key ? [p.key] as const : []))) as OAuthTokens
  if (!needsRefresh(tokens)) return tokens
  if (!p.provider.refresh) throw new ReconnectRequiredError('access token expired; reconnect the account')
  try {
    tokens = await p.provider.refresh(tokens, p.env, p.fetch)
  } catch (e) {
    await db.from('social_credentials_metadata').update({ status: 'refresh_failed' }).eq('workspace_id', p.workspaceId).eq('social_account_id', p.socialAccountId)
    await db.from('social_accounts').update({ status: 'error', last_error: 'Token refresh failed; reconnect the account.' }).eq('workspace_id', p.workspaceId).eq('id', p.socialAccountId)
    throw new ReconnectRequiredError(`token refresh failed: ${(e as Error).message}`)
  }
  await storeTokens(db, p.workspaceId, p.socialAccountId, tokens, p.key)
  return tokens
}

export async function deleteTokens(db: Db, workspaceId: string, socialAccountId: string) {
  const d = await db.rpc('delete_social_credential', { p_social_account_id: socialAccountId })
  if (d.error) throw new Error(`delete credential: ${d.error.message}`)
  await db.from('social_credentials_metadata').update({ status: 'revoked' }).eq('workspace_id', workspaceId).eq('social_account_id', socialAccountId)
}
