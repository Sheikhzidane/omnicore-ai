'use server'

import { z } from 'zod'
import { recordAudit } from '@/lib/audit'
import { runAction, type ActionResult } from '@/lib/actions'
import { queueAgentTask, describeOutcome } from '@/lib/agents/runner'
import { getModerationProvider } from '@/lib/ai/registry'
import { claimsToBeHuman } from '@/lib/content/safety'
import type { Json } from '@/types/database'

const Id = z.uuid()
const PATHS = ['/engagement/inbox', '/engagement/comments', '/engagement/mentions', '/engagement/suggested', '/engagement/moderation']

export async function suggestReplies(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace, user }) => {
    const characterId = Id.parse(fd.get('characterId'))
    const { data } = await db.from('engagement_items').select('id, body, author_handle').eq('workspace_id', workspace.id).eq('character_id', characterId)
      .in('status', ['new', 'needs_reply']).neq('moderation_status', 'blocked').neq('kind', 'dm').order('received_at').limit(20)
    if (!data?.length) throw new Error('nothing waiting for a reply')
    const r = await queueAgentTask(db, process.env, {
      workspaceId: workspace.id, characterId, role: 'community', type: 'suggest_replies', title: `Suggest replies (${data.length})`,
      input: { items: data.map(d => ({ engagementItemId: d.id, body: d.body.slice(0, 2000), ...(d.author_handle ? { author: d.author_handle.slice(0, 200) } : {}) })) },
      userId: user.id, runNow: true,
    })
    return `${describeOutcome(r.outcome)} Suggestions appear under Suggested Replies; nothing is sent without approval.`
  }, PATHS)
}

export async function writeReply(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace }) => {
    const itemId = Id.parse(fd.get('itemId'))
    const body = z.string().trim().min(1).max(2200).parse(fd.get('body'))
    if (claimsToBeHuman(body)) throw new Error('replies must not claim the AI character is a human')
    const item = (await db.from('engagement_items').select('id').eq('workspace_id', workspace.id).eq('id', itemId).single()).data
    if (!item) throw new Error('not found')
    const ins = await db.from('engagement_replies').insert({ workspace_id: workspace.id, engagement_item_id: itemId, body, is_ai_generated: false, status: 'suggested' })
    if (ins.error) throw new Error(ins.error.message)
    return 'Draft reply saved. Request sending when ready.'
  }, PATHS)
}

/** Sending a reply always goes through a human approval. */
export async function requestSend(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace, user }) => {
    const replyId = Id.parse(fd.get('replyId'))
    const edited = String(fd.get('body') ?? '').trim()
    const reply = (await db.from('engagement_replies').select('*').eq('workspace_id', workspace.id).eq('id', replyId).single()).data
    if (!reply || !['suggested', 'failed', 'rejected'].includes(reply.status)) throw new Error('reply is not a draft')
    const body = edited || reply.body
    if (claimsToBeHuman(body)) throw new Error('replies must not claim the AI character is a human')
    if (edited && edited !== reply.body) await db.from('engagement_replies').update({ body: edited.slice(0, 2200) }).eq('id', replyId)
    const item = (await db.from('engagement_items').select('character_id, platform, author_handle, body').eq('id', reply.engagement_item_id).single()).data
    const ins = await db.from('agent_approvals').insert({
      workspace_id: workspace.id, character_id: item?.character_id ?? null, action_type: 'engagement_reply', entity_type: 'engagement_reply', entity_id: replyId,
      title: `Reply on ${item?.platform ?? ''} to @${item?.author_handle ?? 'user'}`.slice(0, 300), summary: `“${item?.body.slice(0, 300) ?? ''}” → “${body.slice(0, 500)}”`,
      payload: { replyId } as Json, risk_level: 'low', status: 'AWAITING_APPROVAL', requested_by_type: 'user', requested_by_user: user.id, idempotency_key: `reply:${replyId}:${Date.now()}`,
    }).select('id').single()
    if (ins.error) throw new Error(ins.error.message)
    await db.from('engagement_replies').update({ status: 'awaiting_approval', approval_id: ins.data.id }).eq('id', replyId)
    await recordAudit({ workspaceId: workspace.id, actorType: 'user', actorId: user.id, action: 'engagement.request_send', entityType: 'engagement_reply', entityId: replyId })
    return 'Sent for approval.'
  }, PATHS)
}

export async function discardReply(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace }) => {
    const replyId = Id.parse(fd.get('replyId'))
    const r = await db.from('engagement_replies').update({ status: 'rejected' }).eq('workspace_id', workspace.id).eq('id', replyId).eq('status', 'suggested')
    if (r.error) throw new Error(r.error.message)
    return 'Discarded.'
  }, PATHS)
}

export async function setItemStatus(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace }) => {
    const itemId = Id.parse(fd.get('itemId'))
    const status = z.enum(['new', 'needs_reply', 'ignored', 'hidden', 'escalated']).parse(fd.get('status'))
    const r = await db.from('engagement_items').update({ status }).eq('workspace_id', workspace.id).eq('id', itemId)
    if (r.error) throw new Error(r.error.message)
    return status === 'hidden' ? 'Hidden in Omnicore (not on the platform).' : `Marked ${status.replace('_', ' ')}.`
  }, PATHS)
}

export async function moderateItems(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace }) => {
    const characterId = Id.parse(fd.get('characterId'))
    const provider = getModerationProvider()
    if (!provider) throw new Error('no moderation provider configured (OPENAI_API_KEY or ANTHROPIC_API_KEY)')
    const { data } = await db.from('engagement_items').select('id, body').eq('workspace_id', workspace.id).eq('character_id', characterId).eq('moderation_status', 'unchecked').limit(25)
    let flagged = 0
    for (const i of data ?? []) {
      const m = await provider.moderate(i.body)
      const hard = m.categories.some(c => /minor|threat|self-harm/i.test(c))
      if (m.flagged) flagged++
      await db.from('engagement_items').update({ moderation_status: !m.flagged ? 'ok' : hard ? 'blocked' : 'flagged', moderation_labels: m.categories as Json, ...(hard ? { status: 'hidden' as const } : {}) }).eq('id', i.id)
    }
    return `Checked ${data?.length ?? 0} item(s); ${flagged} flagged.`
  }, PATHS)
}
