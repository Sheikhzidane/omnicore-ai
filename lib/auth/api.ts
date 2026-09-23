import 'server-only'
import { NextResponse, type NextRequest } from 'next/server'
import type { User } from '@supabase/supabase-js'
import { createRequestClient } from '@/lib/supabase/request'
import { recordAudit } from '@/lib/audit'
import type { WorkspaceRole } from '@/types/database'
import { isEmailAllowed, parseEmailList } from './routes'
import { hasRole } from './roles'

/**
 * Authorisation for Route Handlers. proxy.ts already blocks unauthenticated
 * requests; these guards re-check inside the handler (defence in depth — a
 * proxy/middleware bypass must not expose a privileged action).
 *
 * Every guard returns either { ok: true, ... } or { ok: false, response }
 * where `response` is a ready 401/403/503 to return.
 */

type Denied = { ok: false; response: NextResponse }

const json = (status: number, error: string) => NextResponse.json({ error }, { status })

type RequestClient = NonNullable<ReturnType<typeof createRequestClient>>

/** Verifies the session with the Auth server and applies the email allow-list. */
export async function verifiedUser(supabase: RequestClient | null): Promise<User | null> {
  if (!supabase) return null
  const { data, error } = await supabase.auth.getUser()
  if (error || !data.user) return null
  if (!isEmailAllowed(data.user.email, parseEmailList(process.env.AUTH_ALLOWED_EMAILS))) return null
  return data.user
}

export async function authenticateRequest(req: NextRequest): Promise<User | null> {
  return verifiedUser(createRequestClient(req))
}

export async function requireUserApi(req: NextRequest): Promise<{ ok: true; user: User } | Denied> {
  const user = await authenticateRequest(req)
  if (!user) return { ok: false, response: json(401, 'authentication required') }
  return { ok: true, user }
}

/**
 * Platform-admin gate for privileged ops actions (agent control, task queue,
 * git, panic, outbound email…). Writes an audit entry BEFORE the action; if
 * the audit write fails the action is refused (fail closed).
 */
export async function requirePlatformAdminApi(
  req: NextRequest,
  action: string,
  details: Record<string, string | number | boolean | null> = {},
): Promise<{ ok: true; user: User } | Denied> {
  const supabase = createRequestClient(req)
  const user = await authenticateRequest(req)
  if (!supabase || !user) return { ok: false, response: json(401, 'authentication required') }

  const { data: isAdmin, error } = await supabase.rpc('current_user_is_platform_admin')
  if (error || isAdmin !== true) {
    await recordAudit({ workspaceId: null, actorType: 'user', actorId: user.id, action, outcome: 'denied', details })
    return { ok: false, response: json(403, 'platform admin required') }
  }

  const audited = await recordAudit({ workspaceId: null, actorType: 'user', actorId: user.id, action, details })
  if (!audited) return { ok: false, response: json(503, 'audit log unavailable — action refused') }
  return { ok: true, user }
}

/** Read-only ops endpoints: platform admin required, no audit entry. */
export async function requirePlatformAdminReadApi(req: NextRequest): Promise<{ ok: true; user: User } | Denied> {
  const supabase = createRequestClient(req)
  const user = await authenticateRequest(req)
  if (!supabase || !user) return { ok: false, response: json(401, 'authentication required') }
  const { data: isAdmin, error } = await supabase.rpc('current_user_is_platform_admin')
  if (error || isAdmin !== true) return { ok: false, response: json(403, 'platform admin required') }
  return { ok: true, user }
}

/**
 * Workspace-scoped product APIs. The workspace is derived from the caller's
 * membership (RLS-filtered) — any workspace id in the request is ignored.
 */
export async function requireWorkspaceApi(
  req: NextRequest,
  minRole: WorkspaceRole = 'viewer',
): Promise<{ ok: true; user: User; workspaceId: string; role: WorkspaceRole } | Denied> {
  const supabase = createRequestClient(req)
  const user = await authenticateRequest(req)
  if (!supabase || !user) return { ok: false, response: json(401, 'authentication required') }
  const { data } = await supabase
    .from('workspace_members')
    .select('workspace_id, role, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (!data) return { ok: false, response: json(403, 'no workspace') }
  if (!hasRole(data.role, minRole)) return { ok: false, response: json(403, `requires ${minRole} role`) }
  return { ok: true, user, workspaceId: data.workspace_id, role: data.role }
}
