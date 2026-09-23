import 'server-only'
import { cache } from 'react'
import { redirect } from 'next/navigation'
import type { User } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { supabasePublicEnv } from '@/lib/supabase/env'
import type { WorkspaceRole } from '@/types/database'
import { isEmailAllowed, parseEmailList } from './routes'
import { hasRole } from './roles'

/**
 * Server-side session helpers for Server Components and Server Actions.
 *
 * Identity always comes from `supabase.auth.getUser()`, which validates the
 * session with the Supabase Auth server — never from cookies decoded locally,
 * and never from client-supplied ids. Workspace context is always derived
 * from the membership table under RLS, never from request input.
 */

export interface WorkspaceContext {
  user: User
  workspace: { id: string; name: string }
  role: WorkspaceRole
}

/** The verified user for this request, or null. Cached per request. */
export const getSessionUser = cache(async (): Promise<User | null> => {
  if (!supabasePublicEnv()) return null
  const supabase = await createClient()
  const { data, error } = await supabase.auth.getUser()
  if (error || !data.user) return null
  if (!isEmailAllowed(data.user.email, parseEmailList(process.env.AUTH_ALLOWED_EMAILS))) return null
  return data.user
})

/** Requires a signed-in user; otherwise redirects to /login. */
export async function requireUser(nextPath = '/dashboard'): Promise<User> {
  const user = await getSessionUser()
  if (!user) redirect(`/login?next=${encodeURIComponent(nextPath)}`)
  return user
}

/**
 * The signed-in user's workspace. V1 is single-owner: each user has one
 * workspace (created by the on_auth_user_created trigger). When multiple
 * memberships exist, the oldest is used until a workspace switcher exists.
 */
export const getWorkspaceContext = cache(async (): Promise<WorkspaceContext | null> => {
  const user = await getSessionUser()
  if (!user) return null
  const supabase = await createClient()
  const { data } = await supabase
    .from('workspace_members')
    .select('role, created_at, workspaces(id, name)')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  const ws = data?.workspaces as { id: string; name: string } | null | undefined
  if (!data || !ws) return null
  return { user, workspace: ws, role: data.role }
})

/** Requires workspace membership with at least `minRole`. */
export async function requireWorkspace(minRole: WorkspaceRole = 'viewer'): Promise<WorkspaceContext> {
  await requireUser()
  const ctx = await getWorkspaceContext()
  if (!ctx) redirect('/login?error=no_workspace')
  if (!hasRole(ctx.role, minRole)) redirect('/dashboard?error=forbidden')
  return ctx
}

/** Whether the current user is a platform (ops) admin — checked in the DB. */
export const isPlatformAdmin = cache(async (): Promise<boolean> => {
  const user = await getSessionUser()
  if (!user) return false
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('current_user_is_platform_admin')
  return !error && data === true
})

/** Requires a platform admin; others are sent to the dashboard. */
export async function requirePlatformAdmin(): Promise<User> {
  const user = await requireUser('/ops')
  if (!(await isPlatformAdmin())) redirect('/dashboard?error=ops_forbidden')
  return user
}
