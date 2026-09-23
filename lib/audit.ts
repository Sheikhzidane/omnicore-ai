import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import type { Json } from '@/types/database'

export interface AuditEntry {
  workspaceId: string | null
  actorType: 'user' | 'agent' | 'system'
  actorId: string | null
  action: string
  entityType?: string
  entityId?: string
  outcome?: 'success' | 'denied' | 'error'
  details?: Record<string, Json | undefined>
}

/**
 * Appends to audit_log with the service role. Returns false (never throws) if
 * the write failed. Privileged actions must call this BEFORE acting and refuse
 * to proceed when it returns false — see requirePlatformAdminApi().
 */
export async function recordAudit(entry: AuditEntry): Promise<boolean> {
  try {
    const admin = createAdminClient()
    const { error } = await admin.from('audit_log').insert({
      workspace_id: entry.workspaceId,
      actor_type: entry.actorType,
      actor_id: entry.actorId,
      action: entry.action,
      entity_type: entry.entityType ?? null,
      entity_id: entry.entityId ?? null,
      outcome: entry.outcome ?? 'success',
      details: (entry.details ?? {}) as Json,
    })
    if (error) {
      console.error('[audit] write failed:', error.message)
      return false
    }
    return true
  } catch (e) {
    console.error('[audit] write failed:', (e as Error).message)
    return false
  }
}
