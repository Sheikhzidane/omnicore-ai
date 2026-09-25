import 'server-only'
import { unstable_rethrow } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireWorkspace, type WorkspaceContext } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import type { WorkspaceRole } from '@/types/database'

export type ActionResult = { ok: boolean; message: string } | null

type Ctx = WorkspaceContext & { db: ReturnType<typeof createAdminClient> }

/**
 * Wraps a server action: authenticates, derives the workspace from the
 * caller's membership (never from form input), checks the role, and turns
 * thrown errors into a user-facing message. Writes use the service-role client
 * and MUST scope every query by ctx.workspace.id.
 */
export async function runAction(minRole: WorkspaceRole, fn: (ctx: Ctx) => Promise<string | void>, revalidate: string[] = []): Promise<ActionResult> {
  try {
    const ws = await requireWorkspace(minRole)
    const message = await fn({ ...ws, db: createAdminClient() })
    for (const p of revalidate) revalidatePath(p)
    return { ok: true, message: message || 'Saved.' }
  } catch (e) {
    unstable_rethrow(e)
    if (e instanceof z.ZodError) return { ok: false, message: z.prettifyError(e).slice(0, 500) }
    return { ok: false, message: (e as Error).message.slice(0, 500) }
  }
}

/** FormData → plain object (repeated keys become arrays; empty strings dropped). */
export function formObject(fd: FormData): Record<string, string | string[]> {
  const o: Record<string, string | string[]> = {}
  for (const [k, v] of fd.entries()) {
    if (typeof v !== 'string' || k.startsWith('$ACTION')) continue
    const s = v.trim()
    if (s === '') continue
    o[k] = k in o ? ([] as string[]).concat(o[k], s) : s
  }
  return o
}

/** Splits a comma/newline separated textarea into a clean list. */
export const listField = (v: string | string[] | undefined) =>
  (Array.isArray(v) ? v : (v ?? '').split(/[\n,]/)).map(s => s.trim()).filter(Boolean)

export const boolField = (v: string | string[] | undefined) => v === 'on' || v === 'true'
export const intField = (v: string | string[] | undefined, fallback?: number) => (v === undefined || v === '' ? fallback : Number(v))
