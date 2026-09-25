import 'server-only'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/types/database'
import { recordAudit } from '@/lib/audit'
import { applyDisclosure, missingDisclosures } from '@/lib/safety/disclosure'
import { DEFAULT_POLICY, parsePolicy } from '@/lib/safety/policy'
import type { ModerationProvider } from '@/lib/ai/types'
import { getSocialProvider } from '@/lib/social/providers'
import { composeCaption } from '@/lib/publishing/attempt'
import { assessContent, type Assessment } from './safety'

type Db = SupabaseClient<Database>
export interface Actor { workspaceId: string; userId: string }

/**
 * Content engine. Callers (server actions / route handlers) authorise the
 * user for the workspace first; every function here also scopes by
 * workspace_id and writes an audit entry. Content moves:
 *   draft → (safety review) → in_review → (publish approval) → approved → scheduled → publishing → published
 */

const PLATFORM = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/)
export const NewContentItem = z.object({
  characterId: z.uuid(), platform: PLATFORM,
  format: z.enum(['post', 'carousel', 'reel', 'short', 'story', 'thread', 'video', 'live_script']),
  title: z.string().trim().min(1).max(300), ideaId: z.uuid().optional(), campaignId: z.uuid().optional(),
  brandDealId: z.uuid().optional(), contentRating: z.enum(['general', 'teen', 'mature']).default('general'),
  caption: z.string().max(10000).optional(),
})
export const VersionInput = z.object({
  caption: z.string().max(10000).optional(), script: z.string().max(20000).optional(),
  hashtags: z.array(z.string().trim().min(1).max(100)).max(60).default([]),
  imagePrompt: z.string().max(4000).optional(), videoPrompt: z.string().max(4000).optional(),
})

const fail = (what: string, e: { message: string } | null) => { if (e) throw new Error(`${what}: ${e.message}`) }

export async function createContentItem(db: Db, a: Actor, raw: unknown) {
  const i = NewContentItem.parse(raw)
  const ins = await db.from('content_items').insert({
    workspace_id: a.workspaceId, character_id: i.characterId, platform: i.platform, format: i.format, title: i.title,
    idea_id: i.ideaId ?? null, campaign_id: i.campaignId ?? null, brand_deal_id: i.brandDealId ?? null,
    is_sponsored: Boolean(i.brandDealId), content_rating: i.contentRating, created_by: a.userId,
  }).select('id').single()
  fail('create content', ins.error)
  const id = ins.data!.id
  if (i.caption) await saveVersion(db, a, id, { caption: i.caption, hashtags: [] })
  if (i.ideaId) await db.from('content_ideas').update({ status: 'converted' }).eq('workspace_id', a.workspaceId).eq('id', i.ideaId)
  await recordAudit({ workspaceId: a.workspaceId, actorType: 'user', actorId: a.userId, action: 'content.create', entityType: 'content_item', entityId: id })
  return id
}

export async function saveVersion(db: Db, a: Actor, itemId: string, raw: unknown) {
  const f = VersionInput.parse(raw)
  const item = await db.from('content_items').select('current_version, status').eq('workspace_id', a.workspaceId).eq('id', itemId).single()
  fail('load content', item.error)
  if (!['draft', 'in_review', 'rejected', 'failed'].includes(item.data!.status)) throw new Error(`content is ${item.data!.status}; it can no longer be edited`)
  const version = item.data!.current_version + 1
  const ins = await db.from('content_versions').insert({
    workspace_id: a.workspaceId, content_item_id: itemId, version, caption: f.caption ?? null, script: f.script ?? null,
    hashtags: f.hashtags, image_prompt: f.imagePrompt ?? null, video_prompt: f.videoPrompt ?? null, created_by_type: 'user', created_by: a.userId,
  })
  fail('save version', ins.error)
  // Editing invalidates earlier safety results and any approval.
  const up = await db.from('content_items').update({ current_version: version, status: 'draft', safety_status: 'unchecked', disclosure_applied: false, approval_id: null })
    .eq('workspace_id', a.workspaceId).eq('id', itemId).eq('current_version', item.data!.current_version)
  fail('bump version', up.error)
  await recordAudit({ workspaceId: a.workspaceId, actorType: 'user', actorId: a.userId, action: 'content.version', entityType: 'content_item', entityId: itemId, details: { version } })
  return version
}

/** Applies disclosures (as a new version if needed), runs rules + moderation, and moves the item to in_review. */
export async function runSafetyReview(db: Db, a: Actor, itemId: string, moderation: ModerationProvider | null): Promise<Assessment> {
  const ws = a.workspaceId
  const item = (await db.from('content_items').select('*').eq('workspace_id', ws).eq('id', itemId).single()).data
  if (!item) throw new Error('content not found')
  if (!['draft', 'in_review', 'rejected', 'failed'].includes(item.status)) throw new Error(`content is ${item.status}`)
  const [character, pol, rules, platformPolicies] = await Promise.all([
    db.from('characters').select('*').eq('workspace_id', ws).eq('id', item.character_id).single(),
    db.from('content_policies').select('id, rules, is_default').eq('workspace_id', ws),
    db.from('character_brand_rules').select('rule').eq('workspace_id', ws).eq('character_id', item.character_id).eq('rule_type', 'topic_blocked').eq('active', true),
    db.from('publishing_policies').select('ai_label_required, character_id').eq('workspace_id', ws).eq('platform', item.platform),
  ])
  const ch = character.data
  if (!ch) throw new Error('character not found')
  const policyRow = (pol.data ?? []).find(p => p.id === ch.content_policy_id) ?? (pol.data ?? []).find(p => p.is_default)
  const policy = policyRow ? parsePolicy(policyRow.rules) : DEFAULT_POLICY
  const pp = (platformPolicies.data ?? []).find(p => p.character_id === ch.id) ?? (platformPolicies.data ?? []).find(p => p.character_id === null)
  const platformDisclosure = { ai_label_required: pp?.ai_label_required ?? true }

  let v = (await db.from('content_versions').select('*').eq('workspace_id', ws).eq('content_item_id', itemId).eq('version', item.current_version).maybeSingle()).data
  if (!v) throw new Error('content has no text yet — save a version first')
  let caption = composeCaption(v)
  const missing = missingDisclosures({ caption, character: ch, platform: platformDisclosure, isSponsored: item.is_sponsored })
  if (missing.length) {
    const fixed = applyDisclosure({ caption: v.caption ?? '', character: ch, platform: platformDisclosure, isSponsored: item.is_sponsored })
    await saveVersion(db, a, itemId, { caption: fixed, script: v.script ?? undefined, hashtags: v.hashtags, imagePrompt: v.image_prompt ?? undefined, videoPrompt: v.video_prompt ?? undefined })
    v = (await db.from('content_versions').select('*').eq('workspace_id', ws).eq('content_item_id', itemId).order('version', { ascending: false }).limit(1).single()).data!
    caption = composeCaption(v)
  }
  const text = [caption, v.script ?? ''].filter(Boolean).join('\n\n')

  let modResult = null, modError: string | null = null
  if (moderation) {
    try { modResult = await moderation.moderate(text) } catch (e) { modError = (e as Error).message.slice(0, 300) }
  }
  const assessment = assessContent({
    text, rating: item.content_rating, character: ch, policy, blockedTopics: (rules.data ?? []).map(r => r.rule),
    platformSupportsAgeRestriction: getSocialProvider(item.platform)?.capabilities.ageRestriction ?? false, moderation: modResult,
  })
  if (modError) assessment.reasons.push(`Moderation provider error: ${modError}`)

  const stillMissing = missingDisclosures({ caption, character: ch, platform: platformDisclosure, isSponsored: item.is_sponsored })
  const up = await db.from('content_items').update({
    safety_status: assessment.status, disclosure_applied: stillMissing.length === 0, status: 'in_review',
    safety_report: { rules: { ...assessment, version: v.version, at: new Date().toISOString() }, moderationProvider: modResult?.provider ?? null } as unknown as Json,
  }).eq('workspace_id', ws).eq('id', itemId)
  fail('save safety result', up.error)
  await recordAudit({ workspaceId: ws, actorType: 'user', actorId: a.userId, action: 'content.safety_review', entityType: 'content_item', entityId: itemId, details: { status: assessment.status, version: v.version } })
  return assessment
}

/** A human reviewed flagged content and clears it. Blocked content cannot be cleared — it must be edited. */
export async function clearSafetyFlag(db: Db, a: Actor, itemId: string, note: string) {
  if (note.trim().length < 5) throw new Error('explain why this content is acceptable')
  const item = (await db.from('content_items').select('safety_status, safety_report, current_version').eq('workspace_id', a.workspaceId).eq('id', itemId).single()).data
  if (!item) throw new Error('content not found')
  if (item.safety_status !== 'flagged') throw new Error(`only flagged content can be cleared (status: ${item.safety_status})`)
  const report = { ...(item.safety_report as Record<string, Json>), humanReview: { by: a.userId, at: new Date().toISOString(), note: note.slice(0, 1000), version: item.current_version } }
  const ok = await recordAudit({ workspaceId: a.workspaceId, actorType: 'user', actorId: a.userId, action: 'content.safety_cleared', entityType: 'content_item', entityId: itemId, details: { note: note.slice(0, 500) } })
  if (!ok) throw new Error('audit log unavailable; refusing to clear safety flag')
  const up = await db.from('content_items').update({ safety_status: 'passed', safety_report: report as Json }).eq('workspace_id', a.workspaceId).eq('id', itemId).eq('safety_status', 'flagged').eq('current_version', item.current_version)
  fail('clear flag', up.error)
}

export const PublishRequest = z.object({
  contentItemId: z.uuid(), socialAccountId: z.uuid(),
  scheduledFor: z.iso.datetime({ offset: true }), timezone: z.string().min(1).max(64).default('UTC'),
})

/** Creates the human approval request that — once approved — queues the publishing job. */
export async function requestPublishApproval(db: Db, a: Actor, raw: unknown) {
  const r = PublishRequest.parse(raw)
  const ws = a.workspaceId
  const item = (await db.from('content_items').select('*').eq('workspace_id', ws).eq('id', r.contentItemId).single()).data
  if (!item) throw new Error('content not found')
  if (item.status !== 'in_review') throw new Error('run the safety review first')
  if (item.safety_status !== 'passed') throw new Error(`safety status is ${item.safety_status}; it must be passed (or a flag cleared by a human)`)
  if (!item.disclosure_applied) throw new Error('required disclosures are missing')
  const acct = (await db.from('social_accounts').select('id, platform, character_id, status, handle').eq('workspace_id', ws).eq('id', r.socialAccountId).single()).data
  if (!acct) throw new Error('social account not found')
  if (acct.character_id !== item.character_id) throw new Error('that account belongs to another character')
  if (acct.platform !== item.platform) throw new Error(`content is for ${item.platform}, account is ${acct.platform}`)
  if (acct.status !== 'connected') throw new Error('connect the social account before scheduling')
  if (Date.parse(r.scheduledFor) < Date.now() - 60_000) throw new Error('scheduled time is in the past')

  const payload = { ...r, version: item.current_version }
  const key = `publish:${item.id}:${acct.id}:v${item.current_version}`
  const existing = (await db.from('agent_approvals').select('id, status').eq('workspace_id', ws).eq('idempotency_key', key).maybeSingle()).data
  if (existing) return existing.id
  const ins = await db.from('agent_approvals').insert({
    workspace_id: ws, character_id: item.character_id, action_type: 'publish_content', entity_type: 'content_item', entity_id: item.id,
    title: `Publish "${item.title}" to ${acct.platform}${acct.handle ? ` (@${acct.handle})` : ''}`.slice(0, 300),
    summary: `Version ${item.current_version}, scheduled ${r.scheduledFor} (${r.timezone}).${item.is_sponsored ? ' Sponsored.' : ''}`,
    payload: payload as Json, risk_level: item.is_sponsored ? 'high' : 'medium', status: 'AWAITING_APPROVAL',
    requested_by_type: 'user', requested_by_user: a.userId, idempotency_key: key,
  }).select('id').single()
  fail('request approval', ins.error)
  await recordAudit({ workspaceId: ws, actorType: 'user', actorId: a.userId, action: 'content.request_publish', entityType: 'content_item', entityId: item.id, details: { approvalId: ins.data!.id } })
  return ins.data!.id
}
