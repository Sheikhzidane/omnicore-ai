import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireWorkspaceApi } from '@/lib/auth/api'
import { recordAudit } from '@/lib/audit'
import { createAdminClient } from '@/lib/supabase/admin'
import { getSocialProvider } from '@/lib/social/providers'
import { OAUTH_COOKIE, OAUTH_TTL_SECONDS, beginOAuth } from '@/lib/social/oauth'
import { CredentialVaultNotConfiguredError } from '@/lib/secrets/credentials'

export const dynamic = 'force-dynamic'

/** Starts the OAuth connect flow for one character's account on one platform. Admins only. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ platform: string }> }) {
  const auth = await requireWorkspaceApi(req, 'admin')
  if (!auth.ok) return auth.response
  const { platform } = await params
  const provider = getSocialProvider(platform)
  if (!provider) return NextResponse.json({ error: 'unknown platform' }, { status: 404 })
  if (!provider.configured(process.env)) return NextResponse.json({ error: `${provider.displayName} is not configured on the server` }, { status: 503 })
  const characterId = z.uuid().safeParse(req.nextUrl.searchParams.get('characterId'))
  if (!characterId.success) return NextResponse.json({ error: 'characterId required' }, { status: 400 })

  const db = createAdminClient()
  const ch = await db.from('characters').select('id').eq('workspace_id', auth.workspaceId).eq('id', characterId.data).maybeSingle()
  if (!ch.data) return NextResponse.json({ error: 'character not found' }, { status: 404 })
  const acct = await db.from('social_accounts').upsert(
    { workspace_id: auth.workspaceId, character_id: characterId.data, platform, status: 'pending' },
    { onConflict: 'character_id,platform', ignoreDuplicates: false },
  ).select('id').single()
  if (acct.error) return NextResponse.json({ error: 'could not prepare account' }, { status: 500 })

  try {
    const { url, cookie } = beginOAuth({ provider, env: process.env, workspaceId: auth.workspaceId, socialAccountId: acct.data.id, userId: auth.user.id })
    await recordAudit({ workspaceId: auth.workspaceId, actorType: 'user', actorId: auth.user.id, action: 'social.connect_start', entityType: 'social_account', entityId: acct.data.id, details: { platform } })
    const res = NextResponse.redirect(url)
    res.cookies.set(OAUTH_COOKIE, cookie, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/api/social/callback', maxAge: OAUTH_TTL_SECONDS })
    return res
  } catch (e) {
    const msg = e instanceof CredentialVaultNotConfiguredError ? 'CREDENTIALS_ENCRYPTION_KEY is not configured' : (e as Error).message
    return NextResponse.json({ error: msg }, { status: 503 })
  }
}
