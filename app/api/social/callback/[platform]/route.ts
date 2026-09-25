import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { requireWorkspaceApi } from '@/lib/auth/api'
import { recordAudit } from '@/lib/audit'
import { createAdminClient } from '@/lib/supabase/admin'
import { getSocialProvider } from '@/lib/social/providers'
import { OAUTH_COOKIE, redirectUriFor, verifyOAuthState } from '@/lib/social/oauth'
import { storeTokens } from '@/lib/social/tokens'

export const dynamic = 'force-dynamic'

/** OAuth redirect target. Verifies sealed state, exchanges the code, stores encrypted tokens. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ platform: string }> }) {
  const auth = await requireWorkspaceApi(req, 'admin')
  if (!auth.ok) return auth.response
  const { platform } = await params
  const back = (status: string) => {
    const res = NextResponse.redirect(new URL(`/social?platform=${encodeURIComponent(platform)}&result=${status}`, req.nextUrl.origin))
    res.cookies.delete({ name: OAUTH_COOKIE, path: '/api/social/callback' })
    return res
  }
  const provider = getSocialProvider(platform)
  if (!provider) return back('unknown_platform')
  const q = req.nextUrl.searchParams
  if (q.get('error')) return back('denied')

  const db = createAdminClient()
  let state
  try {
    state = verifyOAuthState(req.cookies.get(OAUTH_COOKIE)?.value, { state: q.get('state'), platform, userId: auth.user.id })
  } catch {
    await recordAudit({ workspaceId: auth.workspaceId, actorType: 'user', actorId: auth.user.id, action: 'social.connect_callback', outcome: 'denied', details: { platform, reason: 'state' } })
    return back('invalid_state')
  }
  if (state.workspaceId !== auth.workspaceId) return back('invalid_state')
  const code = q.get('code')
  if (!code) return back('missing_code')

  try {
    const tokens = await provider.exchangeCode({ code, redirectUri: redirectUriFor(platform, process.env), codeVerifier: state.verifier }, process.env, fetch)
    const identity = await provider.fetchIdentity(tokens, fetch)
    tokens.accountRef = tokens.accountRef ?? identity.externalAccountId
    await storeTokens(db, auth.workspaceId, state.socialAccountId, tokens)
    const up = await db.from('social_accounts').update({
      status: 'connected', external_account_id: identity.externalAccountId, handle: identity.handle, display_name: identity.displayName,
      scopes: tokens.scopes, connected_at: new Date().toISOString(), last_error: null,
    }).eq('workspace_id', auth.workspaceId).eq('id', state.socialAccountId)
    if (up.error) throw new Error(up.error.code === '23505' ? 'this platform account is already connected to another character' : up.error.message)
    await recordAudit({ workspaceId: auth.workspaceId, actorType: 'user', actorId: auth.user.id, action: 'social.connected', entityType: 'social_account', entityId: state.socialAccountId, details: { platform, handle: identity.handle } })
    return back('connected')
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300)
    await db.from('social_accounts').update({ status: 'error', last_error: msg }).eq('workspace_id', auth.workspaceId).eq('id', state.socialAccountId)
    await recordAudit({ workspaceId: auth.workspaceId, actorType: 'user', actorId: auth.user.id, action: 'social.connect_callback', outcome: 'error', entityType: 'social_account', entityId: state.socialAccountId, details: { platform, error: msg } })
    return back('error')
  }
}
