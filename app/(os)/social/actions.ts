'use server'

import { z } from 'zod'
import { recordAudit } from '@/lib/audit'
import { runAction, type ActionResult } from '@/lib/actions'
import { deleteTokens } from '@/lib/social/tokens'

export async function disconnectAccount(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('admin', async ({ db, workspace, user }) => {
    const id = z.uuid().parse(fd.get('accountId'))
    const acct = (await db.from('social_accounts').select('id, platform').eq('workspace_id', workspace.id).eq('id', id).single()).data
    if (!acct) throw new Error('account not found')
    const ok = await recordAudit({ workspaceId: workspace.id, actorType: 'user', actorId: user.id, action: 'social.disconnect', entityType: 'social_account', entityId: id, details: { platform: acct.platform } })
    if (!ok) throw new Error('audit log unavailable')
    await deleteTokens(db, workspace.id, id)
    // Queued posts for this account can no longer be published.
    await db.from('publishing_jobs').update({ status: 'blocked', last_error: 'Account disconnected.' }).eq('workspace_id', workspace.id).eq('social_account_id', id).in('status', ['pending', 'queued'])
    await db.from('social_accounts').update({ status: 'disconnected', connected_at: null }).eq('workspace_id', workspace.id).eq('id', id)
    return 'Disconnected and stored tokens deleted. Also revoke the app in the platform’s own settings if you no longer want it authorised.'
  }, ['/social'])
}
