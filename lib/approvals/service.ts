import 'server-only'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AgentApprovalsRow, Database, Json, WorkspaceRole } from '@/types/database'
import { recordAudit } from '@/lib/audit'
import { hasRole } from '@/lib/auth/roles'
import { getSocialProvider } from '@/lib/social/providers'
import type { Env, FetchFn } from '@/lib/social/providers/types'
import { loadTokens } from '@/lib/social/tokens'
import { publishIdempotencyKey } from '@/lib/scheduling/time'
import { claimsToBeHuman } from '@/lib/content/safety'
import { emailConfigured, outreachFooter, sendApprovedEmail } from '@/lib/email/resend'
import { canDecide } from './rules'

type Db = SupabaseClient<Database>
export interface Decider { workspaceId: string; userId: string; role: WorkspaceRole }
export interface ExecDeps { env: Env; fetch: FetchFn }

/**
 * Human approval system. Only a signed-in workspace member with sufficient
 * role can decide; the database trigger enforces the state machine
 * (AWAITING_APPROVAL → APPROVED/REJECTED → EXECUTING → COMPLETED/FAILED) and
 * requires decided_by. Approved actions run through FIXED executors below —
 * the payload is data, never code, and is re-validated before use.
 */

export async function decideApproval(db: Db, d: Decider, approvalId: string, decision: 'APPROVED' | 'REJECTED', note: string | null, deps: ExecDeps) {
  const a = (await db.from('agent_approvals').select('*').eq('workspace_id', d.workspaceId).eq('id', approvalId).single()).data
  if (!a) throw new Error('approval not found')
  const check = canDecide(a, d.role)
  if (!check.ok) {
    await recordAudit({ workspaceId: d.workspaceId, actorType: 'user', actorId: d.userId, action: 'approval.decide', entityType: 'agent_approval', entityId: approvalId, outcome: 'denied', details: { reason: check.reason } })
    throw new Error(check.reason)
  }
  // Audit BEFORE acting; refuse if the audit trail is unavailable.
  const ok = await recordAudit({ workspaceId: d.workspaceId, actorType: 'user', actorId: d.userId, action: `approval.${decision.toLowerCase()}`, entityType: 'agent_approval', entityId: approvalId, details: { actionType: a.action_type, note: note?.slice(0, 500) ?? null } })
  if (!ok) throw new Error('audit log unavailable; decision not recorded')
  const up = await db.from('agent_approvals').update({ status: decision, decided_by: d.userId, decision_note: note?.slice(0, 2000) ?? null })
    .eq('workspace_id', d.workspaceId).eq('id', approvalId).eq('status', 'AWAITING_APPROVAL').select('*').single()
  if (up.error || !up.data) throw new Error(`decision failed: ${up.error?.message ?? 'already decided'}`)

  if (decision === 'REJECTED') {
    await onRejected(db, up.data)
    return { status: 'REJECTED' as const }
  }
  return executeApproval(db, up.data, d, deps)
}

async function onRejected(db: Db, a: AgentApprovalsRow) {
  const ws = a.workspace_id
  if (a.action_type === 'publish_content' && a.entity_id) {
    await db.from('content_items').update({ status: 'rejected' }).eq('workspace_id', ws).eq('id', a.entity_id).eq('status', 'in_review')
  }
  if (a.action_type === 'engagement_reply') {
    const p = (a.payload ?? {}) as { replyId?: string }
    if (p.replyId) await db.from('engagement_replies').update({ status: 'rejected' }).eq('workspace_id', ws).eq('id', p.replyId)
  }
  if (a.action_type === 'agent_task') {
    const p = (a.payload ?? {}) as { taskId?: string }
    if (p.taskId) await db.from('agent_tasks').update({ status: 'cancelled' }).eq('workspace_id', ws).eq('id', p.taskId).in('status', ['proposed', 'awaiting_approval'])
  }
}

async function transition(db: Db, a: AgentApprovalsRow, status: 'EXECUTING' | 'COMPLETED' | 'FAILED', extra: { result?: Record<string, unknown>; error?: string } = {}) {
  const r = await db.from('agent_approvals').update({ status, ...(extra.result ? { result: extra.result as Json } : {}), ...(extra.error ? { error: extra.error.slice(0, 2000) } : {}) })
    .eq('workspace_id', a.workspace_id).eq('id', a.id)
  if (r.error) throw new Error(`approval ${status}: ${r.error.message}`)
}

const PublishPayload = z.object({ contentItemId: z.uuid(), socialAccountId: z.uuid(), scheduledFor: z.iso.datetime({ offset: true }), timezone: z.string().max(64).optional(), version: z.number().int().positive().optional() })
const ReplyPayload = z.object({ replyId: z.uuid() })
const OutreachPayload = z.object({ contactId: z.uuid(), leadId: z.uuid().optional(), subject: z.string().min(1).max(200), body: z.string().min(1).max(5000) })
const MemoryPayload = z.object({ memoryId: z.uuid() })
const TaskPayload = z.object({ taskId: z.uuid() })

export type ExecResult = { status: 'EXECUTING' | 'COMPLETED' | 'FAILED' | 'APPROVED'; result?: Record<string, unknown>; error?: string }

export async function executeApproval(db: Db, a: AgentApprovalsRow, d: Decider, deps: ExecDeps): Promise<ExecResult> {
  try {
    switch (a.action_type) {
      case 'publish_content': return await execPublish(db, a, d)
      case 'engagement_reply': return await execReply(db, a, deps)
      case 'brand_outreach': return await execOutreach(db, a, deps)
      case 'memory_update': {
        const p = MemoryPayload.parse(a.payload)
        await transition(db, a, 'EXECUTING')
        const r = await db.from('character_memories').update({ is_canon: true, confirmed_by: d.userId, confirmed_at: new Date().toISOString() }).eq('workspace_id', a.workspace_id).eq('id', p.memoryId)
        if (r.error) throw new Error(r.error.message)
        await transition(db, a, 'COMPLETED', { result: { memoryId: p.memoryId } })
        return { status: 'COMPLETED' }
      }
      case 'agent_task': {
        const p = TaskPayload.parse(a.payload)
        await transition(db, a, 'EXECUTING')
        const r = await db.from('agent_tasks').update({ status: 'queued', approved_by: d.userId, approved_at: new Date().toISOString(), approval_id: a.id })
          .eq('workspace_id', a.workspace_id).eq('id', p.taskId).in('status', ['proposed', 'awaiting_approval']).select('id')
        if (r.error) throw new Error(r.error.message)
        if (!r.data?.length) throw new Error('task is no longer awaiting approval')
        await transition(db, a, 'COMPLETED', { result: { taskId: p.taskId, queued: true } })
        return { status: 'COMPLETED' }
      }
      default:
        // No automated executor (credential/policy/financial changes are done by a person in Settings).
        return { status: 'APPROVED', result: { note: 'Approved. This action type is carried out manually.' } }
    }
  } catch (e) {
    const error = (e as Error).message
    const cur = (await db.from('agent_approvals').select('status').eq('id', a.id).single()).data?.status
    if (cur === 'APPROVED') await transition(db, a, 'EXECUTING')
    await transition(db, a, 'FAILED', { error })
    await recordAudit({ workspaceId: a.workspace_id, actorType: 'system', actorId: null, action: 'approval.execute', entityType: 'agent_approval', entityId: a.id, outcome: 'error', details: { error: error.slice(0, 500) } })
    return { status: 'FAILED', error }
  }
}

async function execPublish(db: Db, a: AgentApprovalsRow, d: Decider): Promise<ExecResult> {
  const p = PublishPayload.parse(a.payload)
  const ws = a.workspace_id
  const item = (await db.from('content_items').select('*').eq('workspace_id', ws).eq('id', p.contentItemId).single()).data
  if (!item) throw new Error('content no longer exists')
  if (p.version !== undefined && p.version !== item.current_version) throw new Error(`content changed after the request (v${p.version} → v${item.current_version}); request approval again`)
  if (item.safety_status !== 'passed' || !item.disclosure_applied) throw new Error('content must pass safety review with disclosures applied')
  const acct = (await db.from('social_accounts').select('platform, character_id').eq('workspace_id', ws).eq('id', p.socialAccountId).single()).data
  if (!acct || acct.character_id !== item.character_id || acct.platform !== item.platform) throw new Error('social account does not match the content')

  await transition(db, a, 'EXECUTING', { result: { version: item.current_version } })
  const ap = await db.from('content_items').update({ status: 'approved', approval_id: a.id, scheduled_for: p.scheduledFor, timezone: p.timezone ?? item.timezone })
    .eq('workspace_id', ws).eq('id', item.id).eq('current_version', item.current_version)
  if (ap.error) throw new Error(ap.error.message)
  const job = await db.from('publishing_jobs').insert({
    workspace_id: ws, content_item_id: item.id, social_account_id: p.socialAccountId, platform: item.platform,
    scheduled_for: p.scheduledFor, timezone: p.timezone ?? item.timezone, status: 'queued', approval_id: a.id,
    idempotency_key: publishIdempotencyKey(a.id, p.socialAccountId), created_by: d.userId,
  }).select('id').single()
  if (job.error) {
    await db.from('content_items').update({ status: 'in_review', approval_id: null }).eq('workspace_id', ws).eq('id', item.id)
    throw new Error(job.error.code === '23505' ? 'this content is already scheduled for that account' : job.error.message)
  }
  await db.from('content_items').update({ status: 'scheduled' }).eq('workspace_id', ws).eq('id', item.id)
  await db.from('content_calendar').update({ content_item_id: item.id, status: 'filled' }).eq('workspace_id', ws).eq('character_id', item.character_id)
    .eq('platform', item.platform).eq('slot_date', p.scheduledFor.slice(0, 10)).is('content_item_id', null)
  // Stays EXECUTING until the publishing worker records the result.
  return { status: 'EXECUTING', result: { jobId: job.data!.id } }
}

async function execReply(db: Db, a: AgentApprovalsRow, deps: ExecDeps): Promise<ExecResult> {
  const p = ReplyPayload.parse(a.payload)
  const ws = a.workspace_id
  const reply = (await db.from('engagement_replies').select('*').eq('workspace_id', ws).eq('id', p.replyId).single()).data
  if (!reply) throw new Error('reply not found')
  if (claimsToBeHuman(reply.body)) throw new Error('reply claims the AI character is a human; edit it')
  const item = (await db.from('engagement_items').select('*').eq('workspace_id', ws).eq('id', reply.engagement_item_id).single()).data
  if (!item) throw new Error('engagement item not found')
  if (item.kind === 'dm') throw new Error('direct-message replies are not supported')
  const provider = getSocialProvider(item.platform)
  if (!provider?.replyToComment || !provider.capabilities.replyToComments) throw new Error(`${item.platform} replies are not supported by this integration`)

  await db.from('engagement_replies').update({ status: 'approved', approval_id: a.id }).eq('workspace_id', ws).eq('id', reply.id)
  await transition(db, a, 'EXECUTING')
  try {
    const tokens = await loadTokens(db, { workspaceId: ws, socialAccountId: item.social_account_id, provider, env: deps.env, fetch: deps.fetch })
    const sent = await provider.replyToComment(tokens, item.external_id, reply.body, deps.fetch)
    await db.from('engagement_replies').update({ status: 'sent', sent_at: new Date().toISOString(), external_id: sent.externalId }).eq('workspace_id', ws).eq('id', reply.id)
    await db.from('engagement_items').update({ status: 'replied' }).eq('workspace_id', ws).eq('id', item.id)
    await transition(db, a, 'COMPLETED', { result: { externalId: sent.externalId } })
    return { status: 'COMPLETED' }
  } catch (e) {
    await db.from('engagement_replies').update({ status: 'failed', error: (e as Error).message.slice(0, 1000) }).eq('workspace_id', ws).eq('id', reply.id)
    throw e
  }
}

async function execOutreach(db: Db, a: AgentApprovalsRow, deps: ExecDeps): Promise<ExecResult> {
  const p = OutreachPayload.parse(a.payload)
  const ws = a.workspace_id
  const contact = (await db.from('brand_contacts').select('*').eq('workspace_id', ws).eq('id', p.contactId).single()).data
  if (!contact) throw new Error('contact not found')
  if (contact.do_not_contact || contact.opted_out_at) throw new Error('this contact has opted out — do not contact')
  const character = a.character_id ? (await db.from('characters').select('name').eq('id', a.character_id).single()).data : null
  const text = `${p.body}\n\n${outreachFooter(character?.name ?? 'This character')}`
  await transition(db, a, 'EXECUTING')
  let result: Record<string, unknown>
  if (emailConfigured(deps.env) && contact.email) {
    const sent = await sendApprovedEmail(deps.env, deps.fetch, { to: contact.email, subject: p.subject, text, idempotencyKey: `outreach:${a.id}` })
    result = { delivery: 'email', messageId: sent.id }
  } else {
    result = { delivery: 'manual', note: contact.email ? 'Email sending is not configured. Copy the approved text and send it yourself.' : 'Contact has no email address. Send the approved text through your own channel.', text }
  }
  if (p.leadId) await db.from('leads').update({ stage: 'pitched', stage_changed_at: new Date().toISOString() }).eq('workspace_id', ws).eq('id', p.leadId).in('stage', ['prospect', 'researched'])
  await transition(db, a, 'COMPLETED', { result })
  return { status: 'COMPLETED', result }
}

/** Reset a FAILED approval for another attempt — needs a fresh human decision. */
export async function retryApproval(db: Db, d: Decider, approvalId: string) {
  if (!hasRole(d.role, 'editor')) throw new Error('editors and above can retry approvals')
  const r = await db.from('agent_approvals').update({ status: 'AWAITING_APPROVAL', error: null }).eq('workspace_id', d.workspaceId).eq('id', approvalId).eq('status', 'FAILED')
  if (r.error) throw new Error(r.error.message)
  await recordAudit({ workspaceId: d.workspaceId, actorType: 'user', actorId: d.userId, action: 'approval.retry', entityType: 'agent_approval', entityId: approvalId })
}
