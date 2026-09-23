import 'server-only'
import type { User } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'
import { recordAudit } from '@/lib/audit'
import { parseEmailList } from './routes'

/**
 * Grants or revokes platform-admin (/ops) access after a VERIFIED sign-in,
 * based solely on the server-side OPS_ADMIN_EMAILS env var. Nothing the client
 * sends can influence it.
 */
export async function syncPlatformAdmin(user: User): Promise<void> {
  const admins = parseEmailList(process.env.OPS_ADMIN_EMAILS)
  const isAdmin = !!user.email && admins.has(user.email.toLowerCase())
  try {
    const admin = createAdminClient()
    const { error } = await admin.rpc('sync_platform_admin', { p_user_id: user.id, p_is_admin: isAdmin })
    if (error) throw new Error(error.message)
    if (isAdmin) {
      await recordAudit({ workspaceId: null, actorType: 'system', actorId: user.id, action: 'ops.admin_synced', details: { isAdmin } })
    }
  } catch (e) {
    // Service role not configured: /ops stays closed (fail closed).
    console.error('[ops-admin] sync failed:', (e as Error).message)
  }
}
