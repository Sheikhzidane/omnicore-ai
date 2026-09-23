'use server'

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { supabasePublicEnv } from '@/lib/supabase/env'
import { isEmailAllowed, parseEmailList, safeNextPath } from '@/lib/auth/routes'
import { syncPlatformAdmin } from '@/lib/auth/ops-admin'
import { recordAudit } from '@/lib/audit'

export interface LoginState {
  error?: string
  message?: string
}

const email = z.string().trim().toLowerCase().email().max(320)
const PasswordForm = z.object({ email, password: z.string().min(8).max(200), next: z.string().optional() })
const MagicLinkForm = z.object({ email, next: z.string().optional() })

// Deliberately generic: never reveal whether an account exists or is allowed.
const GENERIC_FAILURE = 'Sign-in failed. Check your details and try again.'
const MAGIC_LINK_SENT = 'If that email can sign in, a sign-in link is on its way.'

async function siteOrigin(): Promise<string> {
  const configured = process.env.NEXT_PUBLIC_SITE_URL
  if (configured) return configured.replace(/\/$/, '')
  const h = await headers()
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000'
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https')
  return `${proto}://${host}`
}

export async function signInWithPassword(_prev: LoginState, formData: FormData): Promise<LoginState> {
  if (!supabasePublicEnv()) return { error: 'Authentication is not configured (NEXT_PUBLIC_SUPABASE_URL / ANON_KEY).' }
  const parsed = PasswordForm.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: GENERIC_FAILURE }

  if (!isEmailAllowed(parsed.data.email, parseEmailList(process.env.AUTH_ALLOWED_EMAILS))) {
    await recordAudit({ workspaceId: null, actorType: 'system', actorId: null, action: 'auth.sign_in', outcome: 'denied', details: { reason: 'not_allow_listed' } })
    return { error: GENERIC_FAILURE }
  }

  const supabase = await createClient()
  const { data, error } = await supabase.auth.signInWithPassword({ email: parsed.data.email, password: parsed.data.password })
  if (error || !data.user) {
    await recordAudit({ workspaceId: null, actorType: 'system', actorId: null, action: 'auth.sign_in', outcome: 'denied', details: { method: 'password' } })
    return { error: GENERIC_FAILURE }
  }

  await syncPlatformAdmin(data.user)
  await recordAudit({ workspaceId: null, actorType: 'user', actorId: data.user.id, action: 'auth.sign_in', details: { method: 'password' } })
  redirect(safeNextPath(parsed.data.next))
}

export async function sendMagicLink(_prev: LoginState, formData: FormData): Promise<LoginState> {
  if (!supabasePublicEnv()) return { error: 'Authentication is not configured (NEXT_PUBLIC_SUPABASE_URL / ANON_KEY).' }
  const parsed = MagicLinkForm.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: 'Enter a valid email address.' }

  const allowList = parseEmailList(process.env.AUTH_ALLOWED_EMAILS)
  if (!isEmailAllowed(parsed.data.email, allowList)) return { message: MAGIC_LINK_SENT }

  const next = safeNextPath(parsed.data.next)
  const supabase = await createClient()
  await supabase.auth.signInWithOtp({
    email: parsed.data.email,
    options: {
      emailRedirectTo: `${await siteOrigin()}/auth/callback?next=${encodeURIComponent(next)}`,
      // V1 single owner: accounts are only auto-created for allow-listed
      // emails. With no allow-list, only pre-existing users can sign in.
      shouldCreateUser: allowList.size > 0,
    },
  })
  return { message: MAGIC_LINK_SENT }
}
