'use server'

import { redirect } from 'next/navigation'
import { z } from 'zod'
import { recordAudit } from '@/lib/audit'
import { runAction, formObject, boolField, type ActionResult } from '@/lib/actions'
import { createContentItem, runSafetyReview, clearSafetyFlag, requestPublishApproval, saveVersion } from '@/lib/content/service'
import { generateImageForItem } from '@/lib/content/media'
import { getImageProvider, getModerationProvider } from '@/lib/ai/registry'
import { queueAgentTask, describeOutcome } from '@/lib/agents/runner'
import { zonedToUtc } from '@/lib/scheduling/time'
import { buildObjectPath, validateUpload } from '@/lib/storage/buckets'
import { createSignedUpload } from '@/lib/storage/server'

const Id = z.uuid()
const PLATFORMS = z.enum(['instagram', 'tiktok', 'youtube', 'x'])
const actor = (w: { workspace: { id: string }; user: { id: string } }) => ({ workspaceId: w.workspace.id, userId: w.user.id })

// ── Ideas ────────────────────────────────────────────────────────────────────
export async function addIdea(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace, user }) => {
    const f = formObject(fd)
    const i = z.object({ characterId: Id, title: z.string().trim().min(1).max(300), summary: z.string().max(2000).optional(), angle: z.string().max(500).optional() }).parse(f)
    const platforms = z.array(PLATFORMS).parse(([] as string[]).concat(f.platforms ?? []))
    const ins = await db.from('content_ideas').insert({ workspace_id: workspace.id, character_id: i.characterId, title: i.title, summary: i.summary ?? null, angle: i.angle ?? null, platforms, source: 'owner', created_by: user.id })
    if (ins.error) throw new Error(ins.error.message)
    return 'Idea saved.'
  }, ['/content/ideas'])
}

export async function setIdeaStatus(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace }) => {
    const id = Id.parse(fd.get('ideaId'))
    const status = z.enum(['accepted', 'rejected', 'new']).parse(fd.get('status'))
    const up = await db.from('content_ideas').update({ status }).eq('workspace_id', workspace.id).eq('id', id)
    if (up.error) throw new Error(up.error.message)
    return `Idea ${status}.`
  }, ['/content/ideas'])
}

export async function generateIdeas(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace, user }) => {
    const f = formObject(fd)
    const characterId = Id.parse(f.characterId)
    const count = z.coerce.number().int().min(1).max(10).parse(f.count ?? 5)
    const r = await queueAgentTask(db, process.env, {
      workspaceId: workspace.id, characterId, role: 'content_planner', type: 'generate_ideas', title: `Generate ${count} ideas`,
      input: { count, ...(f.theme ? { theme: String(f.theme).slice(0, 500) } : {}), platforms: [] }, userId: user.id, runNow: true,
    })
    return describeOutcome(r.outcome)
  }, ['/content/ideas'])
}

// ── Items ────────────────────────────────────────────────────────────────────
export async function createItem(_: ActionResult, fd: FormData): Promise<ActionResult> {
  let id: string | null = null
  const res = await runAction('editor', async (w) => {
    const f = formObject(fd)
    id = await createContentItem(w.db, actor(w), {
      characterId: f.characterId, platform: f.platform, format: f.format, title: f.title, ideaId: f.ideaId, caption: f.caption, contentRating: f.contentRating ?? 'general',
      ...(f.brandDealId ? { brandDealId: f.brandDealId } : {}),
    })
    if (boolField(f.draftWithAi)) {
      const r = await queueAgentTask(w.db, process.env, {
        workspaceId: w.workspace.id, characterId: String(f.characterId), role: 'copywriter', type: 'write_caption', title: `Caption: ${String(f.title).slice(0, 200)}`,
        input: { contentItemId: id, brief: String(f.brief ?? f.title).slice(0, 4000), platform: f.platform, format: f.format }, userId: w.user.id, runNow: true,
      })
      return `Content created. Copywriter: ${describeOutcome(r.outcome)}`
    }
    return 'Content created.'
  }, ['/content/generator', '/content/history'])
  if (res?.ok && id) redirect(`/content/items/${id}`)
  return res
}

export async function saveItemVersion(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async (w) => {
    const f = formObject(fd)
    const itemId = Id.parse(f.itemId)
    const hashtags = String(f.hashtags ?? '').split(/[\s,]+/).map(h => h.replace(/^#/, '').trim()).filter(Boolean)
    const v = await saveVersion(w.db, actor(w), itemId, { caption: f.caption, script: f.script, hashtags, imagePrompt: f.imagePrompt, videoPrompt: f.videoPrompt })
    return `Saved as version ${v}. Run the safety review before requesting approval.`
  }, ['/content'])
}

export async function askAgent(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async (w) => {
    const f = formObject(fd)
    const itemId = Id.parse(f.itemId)
    const which = z.enum(['copywriter', 'image_prompt', 'video_script', 'quality', 'creative_director', 'safety', 'character']).parse(f.agent)
    const item = (await w.db.from('content_items').select('*').eq('workspace_id', w.workspace.id).eq('id', itemId).single()).data
    if (!item) throw new Error('content not found')
    const v = (await w.db.from('content_versions').select('caption, script').eq('content_item_id', itemId).eq('version', item.current_version).maybeSingle()).data
    const text = [v?.caption, v?.script].filter(Boolean).join('\n\n')
    const brief = String(f.brief || item.title).slice(0, 4000)
    const needsText = ['quality', 'creative_director', 'safety', 'character'].includes(which)
    if (needsText && !text) throw new Error('write or generate a draft first')
    const spec: Record<typeof which, { type: string; input: Record<string, unknown> }> = {
      copywriter: { type: 'write_caption', input: { contentItemId: itemId, brief, platform: item.platform, format: item.format } },
      image_prompt: { type: 'image_prompt', input: { contentItemId: itemId, brief } },
      video_script: { type: 'video_script', input: { contentItemId: itemId, brief, seconds: 30 } },
      quality: { type: 'quality_review', input: { contentItemId: itemId, text, platform: item.platform } },
      creative_director: { type: 'creative_review', input: { contentItemId: itemId, text } },
      safety: { type: 'safety_review', input: { contentItemId: itemId, text, isSponsored: item.is_sponsored } },
      character: { type: 'consistency_review', input: { contentItemId: itemId, text } },
    }
    const s = spec[which]
    const r = await queueAgentTask(w.db, process.env, { workspaceId: w.workspace.id, characterId: item.character_id, role: which, type: s.type, title: `${s.type}: ${item.title}`.slice(0, 300), input: s.input, userId: w.user.id, runNow: true })
    return describeOutcome(r.outcome)
  }, ['/content'])
}

export async function runSafety(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async (w) => {
    const itemId = Id.parse(fd.get('itemId'))
    const a = await runSafetyReview(w.db, actor(w), itemId, getModerationProvider())
    return `Safety review: ${a.status.toUpperCase()}${a.reasons.length ? ` — ${a.reasons.join(' ')}` : ''}`
  }, ['/content'])
}

export async function clearFlag(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async (w) => {
    await clearSafetyFlag(w.db, actor(w), Id.parse(fd.get('itemId')), String(fd.get('note') ?? ''))
    return 'Flag cleared by human review.'
  }, ['/content'])
}

export async function requestPublish(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async (w) => {
    const f = formObject(fd)
    const tz = String(f.timezone ?? 'UTC')
    const scheduledFor = zonedToUtc(String(f.date), String(f.time), tz)
    const id = await requestPublishApproval(w.db, actor(w), { contentItemId: f.itemId, socialAccountId: f.socialAccountId, scheduledFor, timezone: tz })
    return `Approval requested (${id.slice(0, 8)}). Decide it in the Approval Queue.`
  }, ['/content'])
}

export async function generateImage(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async (w) => {
    const itemId = Id.parse(fd.get('itemId'))
    await generateImageForItem(w.db, actor(w), itemId, getImageProvider())
    return 'Image generated and saved to Generated Assets.'
  }, ['/content'])
}

export async function archiveItem(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace, user }) => {
    const itemId = Id.parse(fd.get('itemId'))
    const up = await db.from('content_items').update({ status: 'archived' }).eq('workspace_id', workspace.id).eq('id', itemId).in('status', ['draft', 'in_review', 'rejected', 'failed', 'published'])
    if (up.error) throw new Error(up.error.message)
    await recordAudit({ workspaceId: workspace.id, actorType: 'user', actorId: user.id, action: 'content.archive', entityType: 'content_item', entityId: itemId })
    return 'Archived.'
  }, ['/content'])
}

// ── Media upload for a content item ─────────────────────────────────────────
export async function prepareContentUpload(input: { itemId: string; fileName: string; mimeType: string; bytes: number }) {
  let out: { path: string; token: string } | null = null
  const res = await runAction('editor', async ({ db, workspace }) => {
    const i = z.object({ itemId: Id, fileName: z.string().min(1).max(200), mimeType: z.string().max(100), bytes: z.number().int().positive() }).parse(input)
    const item = (await db.from('content_items').select('character_id').eq('workspace_id', workspace.id).eq('id', i.itemId).single()).data
    if (!item) throw new Error('content not found')
    const v = validateUpload('generated-content', i.mimeType, i.bytes)
    if (!v.ok) throw new Error(v.reason)
    const path = buildObjectPath(workspace.id, item.character_id, i.fileName)
    const s = await createSignedUpload(db, { workspaceId: workspace.id, bucket: 'generated-content', path, mimeType: i.mimeType, bytes: i.bytes })
    out = { path: s.path, token: s.token }
  })
  return res?.ok && out ? { ok: true as const, ...(out as { path: string; token: string }) } : { ok: false as const, message: res?.message ?? 'failed' }
}

export async function confirmContentUpload(input: { itemId: string; path: string; mimeType: string; bytes: number }): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace, user }) => {
    const i = z.object({ itemId: Id, path: z.string().max(500), mimeType: z.string().max(100), bytes: z.number().int().positive() }).parse(input)
    const item = (await db.from('content_items').select('character_id').eq('workspace_id', workspace.id).eq('id', i.itemId).single()).data
    if (!item || !i.path.startsWith(`${workspace.id}/${item.character_id}/`)) throw new Error('invalid upload')
    if (!(await db.storage.from('generated-content').exists(i.path)).data) throw new Error('upload not found in storage')
    const kind = i.mimeType.startsWith('video/') ? 'video' : i.mimeType.startsWith('audio/') ? 'audio' : 'image'
    const ins = await db.from('content_assets').insert({ workspace_id: workspace.id, character_id: item.character_id, content_item_id: i.itemId, kind, storage_bucket: 'generated-content', storage_path: i.path, mime_type: i.mimeType, bytes: i.bytes, provenance: 'uploaded', status: 'ready' })
    if (ins.error) throw new Error(ins.error.message)
    await recordAudit({ workspaceId: workspace.id, actorType: 'user', actorId: user.id, action: 'content.upload_media', entityType: 'content_item', entityId: i.itemId })
    return 'Media attached.'
  }, ['/content'])
}

export async function removeContentAsset(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace }) => {
    const id = Id.parse(fd.get('assetId'))
    const a = (await db.from('content_assets').select('storage_bucket, storage_path').eq('workspace_id', workspace.id).eq('id', id).single()).data
    if (!a) throw new Error('asset not found')
    await db.storage.from(a.storage_bucket).remove([a.storage_path])
    await db.from('content_assets').update({ status: 'deleted' }).eq('workspace_id', workspace.id).eq('id', id)
    return 'Removed.'
  }, ['/content'])
}

// ── Calendar ────────────────────────────────────────────────────────────────
export async function addCalendarSlot(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace }) => {
    const f = z.object({ characterId: Id, platform: PLATFORMS, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), time: z.string().regex(/^\d{2}:\d{2}$/).optional(), timezone: z.string().max(64).default('UTC'), note: z.string().max(500).optional() }).parse(formObject(fd))
    const ins = await db.from('content_calendar').insert({ workspace_id: workspace.id, character_id: f.characterId, platform: f.platform, slot_date: f.date, slot_time: f.time ?? null, timezone: f.timezone, note: f.note ?? null })
    if (ins.error) throw new Error(ins.error.message)
    return 'Slot added.'
  }, ['/content/calendar'])
}

export async function planCalendar(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace, user }) => {
    const f = formObject(fd)
    const characterId = Id.parse(f.characterId)
    const platforms = z.array(PLATFORMS).min(1).parse(([] as string[]).concat(f.platforms ?? []))
    const r = await queueAgentTask(db, process.env, {
      workspaceId: workspace.id, characterId, role: 'content_planner', type: 'plan_calendar', title: 'Plan content calendar',
      input: { startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(f.startDate), days: z.coerce.number().int().min(1).max(31).parse(f.days ?? 7), platforms, timezone: String(f.timezone ?? 'UTC') },
      userId: user.id, runNow: true,
    })
    return describeOutcome(r.outcome)
  }, ['/content/calendar'])
}

// ── Publishing queue ────────────────────────────────────────────────────────
export async function cancelJob(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace, user }) => {
    const jobId = Id.parse(fd.get('jobId'))
    const job = (await db.from('publishing_jobs').update({ status: 'cancelled', locked_at: null }).eq('workspace_id', workspace.id).eq('id', jobId).in('status', ['pending', 'queued']).select('*').maybeSingle()).data
    if (!job) throw new Error('only pending or queued jobs can be cancelled')
    await db.from('content_items').update({ status: 'in_review', approval_id: null, scheduled_for: null }).eq('workspace_id', workspace.id).eq('id', job.content_item_id).in('status', ['approved', 'scheduled'])
    if (job.approval_id) await db.from('agent_approvals').update({ status: 'FAILED', error: 'Cancelled by a user before publishing.' }).eq('workspace_id', workspace.id).eq('id', job.approval_id).eq('status', 'EXECUTING')
    await recordAudit({ workspaceId: workspace.id, actorType: 'user', actorId: user.id, action: 'publishing.cancel', entityType: 'publishing_job', entityId: jobId })
    return 'Cancelled. The content is back in review.'
  }, ['/content/publishing'])
}

export async function retryJob(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace, user }) => {
    const jobId = Id.parse(fd.get('jobId'))
    const job = (await db.from('publishing_jobs').select('*').eq('workspace_id', workspace.id).eq('id', jobId).single()).data
    if (!job || !['failed', 'blocked'].includes(job.status)) throw new Error('only failed or blocked jobs can be retried')
    if (!job.approval_id) throw new Error('job has no approval')
    // A retry is a new job under a fresh approval: request approval again from the content page.
    await recordAudit({ workspaceId: workspace.id, actorType: 'user', actorId: user.id, action: 'publishing.retry_requested', entityType: 'publishing_job', entityId: jobId })
    redirect(`/content/items/${job.content_item_id}`)
  })
}

