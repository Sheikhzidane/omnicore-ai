'use server'

import { z } from 'zod'
import { recordAudit } from '@/lib/audit'
import { runAction, formObject, boolField, type ActionResult } from '@/lib/actions'
import { isEmailAllowed, parseEmailList } from '@/lib/auth/routes'

const Id = z.uuid()

export async function renameWorkspace(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('owner', async ({ db, workspace, user }) => {
    const name = z.string().trim().min(1).max(120).parse(fd.get('name'))
    const r = await db.from('workspaces').update({ name }).eq('id', workspace.id)
    if (r.error) throw new Error(r.error.message)
    await recordAudit({ workspaceId: workspace.id, actorType: 'user', actorId: user.id, action: 'workspace.rename', details: { name } })
    return 'Workspace renamed.'
  }, ['/settings'])
}

/** Adds an EXISTING, allow-listed user (they must have signed in once). There is no public sign-up. */
export async function addMember(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('owner', async ({ db, workspace, user }) => {
    const f = z.object({ email: z.email().transform(e => e.toLowerCase()), role: z.enum(['admin', 'editor', 'viewer']) }).parse(formObject(fd))
    if (!isEmailAllowed(f.email, parseEmailList(process.env.AUTH_ALLOWED_EMAILS))) throw new Error('add this email to AUTH_ALLOWED_EMAILS first (server environment)')
    let target: { id: string } | undefined
    for (let page = 1; page <= 20 && !target; page++) {
      const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 })
      if (error) throw new Error(error.message)
      target = data.users.find(u => u.email?.toLowerCase() === f.email)
      if (data.users.length < 200) break
    }
    if (!target) throw new Error('no account with that email yet — ask them to sign in once with a magic link, then add them')
    const ok = await recordAudit({ workspaceId: workspace.id, actorType: 'user', actorId: user.id, action: 'workspace.add_member', entityType: 'user', entityId: target.id, details: { role: f.role } })
    if (!ok) throw new Error('audit log unavailable')
    const r = await db.from('workspace_members').upsert({ workspace_id: workspace.id, user_id: target.id, role: f.role }, { onConflict: 'workspace_id,user_id' })
    if (r.error) throw new Error(r.error.message)
    return 'Member added.'
  }, ['/settings/users'])
}

export async function changeMember(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('owner', async ({ db, workspace, user }) => {
    const userId = Id.parse(fd.get('userId'))
    const action = z.enum(['admin', 'editor', 'viewer', 'remove']).parse(fd.get('action'))
    if (userId === user.id) throw new Error('you cannot change your own membership')
    const m = (await db.from('workspace_members').select('role').eq('workspace_id', workspace.id).eq('user_id', userId).single()).data
    if (!m) throw new Error('not a member')
    if (m.role === 'owner') throw new Error('the owner cannot be changed here')
    const ok = await recordAudit({ workspaceId: workspace.id, actorType: 'user', actorId: user.id, action: `workspace.member_${action}`, entityType: 'user', entityId: userId })
    if (!ok) throw new Error('audit log unavailable')
    const r = action === 'remove'
      ? await db.from('workspace_members').delete().eq('workspace_id', workspace.id).eq('user_id', userId)
      : await db.from('workspace_members').update({ role: action }).eq('workspace_id', workspace.id).eq('user_id', userId)
    if (r.error) throw new Error(r.error.message)
    return action === 'remove' ? 'Removed.' : 'Role changed.'
  }, ['/settings/users'])
}

export async function savePublishingPolicy(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('admin', async ({ db, workspace, user }) => {
    const f = formObject(fd)
    const p = z.object({
      platform: z.enum(['instagram', 'tiktok', 'youtube', 'x']), characterId: z.uuid().optional(),
      maxPostsPerDay: z.coerce.number().int().min(0).max(25), minMinutesBetweenPosts: z.coerce.number().int().min(15).max(10080),
    }).parse(f)
    const row = {
      publishing_enabled: boolField(f.publishingEnabled), requires_human_approval: boolField(f.requiresHumanApproval), ai_label_required: boolField(f.aiLabelRequired),
      auto_publish_allowed: boolField(f.autoPublishAllowed), max_posts_per_day: p.maxPostsPerDay, min_minutes_between_posts: p.minMinutesBetweenPosts,
    }
    if (row.auto_publish_allowed && row.requires_human_approval) throw new Error('auto-publishing needs "requires human approval" turned off')
    const ok = await recordAudit({ workspaceId: workspace.id, actorType: 'user', actorId: user.id, action: 'policy.publishing_update', details: { platform: p.platform, characterId: p.characterId ?? null, ...row } })
    if (!ok) throw new Error('audit log unavailable; policy not changed')
    let q = db.from('publishing_policies').select('id').eq('workspace_id', workspace.id).eq('platform', p.platform)
    q = p.characterId ? q.eq('character_id', p.characterId) : q.is('character_id', null)
    const existing = (await q.maybeSingle()).data
    const r = existing
      ? await db.from('publishing_policies').update(row).eq('id', existing.id)
      : await db.from('publishing_policies').insert({ workspace_id: workspace.id, platform: p.platform, character_id: p.characterId ?? null, ...row })
    if (r.error) throw new Error(r.error.message)
    return 'Policy saved.'
  }, ['/settings/publishing-policies'])
}
