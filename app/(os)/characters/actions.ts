'use server'

import { redirect } from 'next/navigation'
import { z } from 'zod'
import { recordAudit } from '@/lib/audit'
import { runAction, formObject, listField, boolField, intField, type ActionResult } from '@/lib/actions'
import { AGENT_DEFINITIONS } from '@/lib/agents/definitions'
import { BrandRule, CharacterBasics, CharacterVoice, ContentBoundaries, CreateCharacterInput, MemoryInput, MonetisationStrategy, PlatformStrategy, SafetySettings, VisualIdentity, slugify } from '@/lib/characters/schema'
import { ContentPolicyRules, parsePolicy } from '@/lib/safety/policy'
import { buildObjectPath, validateUpload, type BucketId } from '@/lib/storage/buckets'
import { createSignedUpload } from '@/lib/storage/server'
import type { AgentRole, Json } from '@/types/database'

const Id = z.uuid()

async function uniqueSlug(db: Parameters<Parameters<typeof runAction>[1]>[0]['db'], ws: string, base: string) {
  const { data } = await db.from('characters').select('slug').eq('workspace_id', ws).like('slug', `${base}%`)
  const taken = new Set((data ?? []).map(r => r.slug))
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`
}

/** Wizard submit: character + identity + the 15-agent roster (all disabled). */
export async function createCharacter(_: ActionResult, fd: FormData): Promise<ActionResult> {
  let createdId: string | null = null
  const res = await runAction('editor', async ({ db, workspace, user }) => {
    const input = CreateCharacterInput.parse(JSON.parse(String(fd.get('payload') ?? '{}')))
    const ws = workspace.id
    const slug = await uniqueSlug(db, ws, input.basics.slug ?? slugify(input.basics.name))
    const s = input.safety
    const ch = await db.from('characters').insert({
      workspace_id: ws, name: input.basics.name, slug, status: 'draft', created_by: user.id,
      ai_disclosure_mode: s.aiDisclosureMode, disclosure_text: s.disclosureText, approval_mode: s.approvalMode,
      min_audience_age: s.minAudienceAge, age_restricted: s.ageRestricted, depicts_real_person: s.depictsRealPerson,
      consent_evidence_path: s.consentEvidencePath ?? null,
    }).select('id').single()
    if (ch.error) throw new Error(ch.error.message)
    const id = ch.data.id
    const b = input.basics, v = input.voice, vis = input.visual
    const writes = await Promise.all([
      db.from('character_profiles').insert({
        workspace_id: ws, character_id: id, display_name: b.displayName, description: b.description ?? null, niche: b.niche ?? null,
        target_audience: b.targetAudience ?? null, personality: v.personality as Json, tone_of_voice: v.toneOfVoice ?? null,
        backstory: v.backstory ?? null, content_boundaries: input.boundaries as Json, platform_strategy: input.platformStrategy as Json,
        monetisation_strategy: input.monetisationStrategy as Json, language: b.language,
      }),
      db.from('character_visual_rules').insert({
        workspace_id: ws, character_id: id, appearance_description: vis.appearanceDescription ?? null, style_keywords: vis.styleKeywords,
        color_palette: vis.colorPalette, camera_style: vis.cameraStyle ?? null, prompt_prefix: vis.promptPrefix ?? null,
        negative_prompt: vis.negativePrompt ?? null, do_not_depict: vis.doNotDepict,
      }),
      input.brandRules.length
        ? db.from('character_brand_rules').insert(input.brandRules.map(r => ({ workspace_id: ws, character_id: id, rule_type: r.ruleType, rule: r.rule, priority: r.priority })))
        : Promise.resolve({ error: null }),
      db.from('agents').insert((Object.keys(AGENT_DEFINITIONS) as AgentRole[]).map(role => ({
        workspace_id: ws, character_id: id, role, name: AGENT_DEFINITIONS[role].name, status: 'disabled' as const, autonomy: 'approval_required' as const,
      }))),
    ])
    const failed = writes.find(w => w.error)
    if (failed?.error) throw new Error(failed.error.message)
    await recordAudit({ workspaceId: ws, actorType: 'user', actorId: user.id, action: 'character.create', entityType: 'character', entityId: id, details: { name: input.basics.name } })
    createdId = id
    return 'Character created.'
  }, ['/characters'])
  if (res?.ok && createdId) redirect(`/characters/${createdId}`)
  return res
}

export async function updateBasics(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace, user }) => {
    const f = formObject(fd)
    const id = Id.parse(f.id)
    const b = CharacterBasics.parse({ name: f.name, displayName: f.displayName, description: f.description, niche: f.niche, targetAudience: f.targetAudience, language: f.language ?? 'en' })
    const status = z.enum(['draft', 'active', 'paused', 'archived']).parse(f.status)
    const up1 = await db.from('characters').update({ name: b.name, status }).eq('workspace_id', workspace.id).eq('id', id)
    if (up1.error) throw new Error(up1.error.message)
    const up2 = await db.from('character_profiles').update({ display_name: b.displayName, description: b.description ?? null, niche: b.niche ?? null, target_audience: b.targetAudience ?? null, language: b.language })
      .eq('workspace_id', workspace.id).eq('character_id', id)
    if (up2.error) throw new Error(up2.error.message)
    await recordAudit({ workspaceId: workspace.id, actorType: 'user', actorId: user.id, action: 'character.update_profile', entityType: 'character', entityId: id, details: { status } })
  }, ['/characters'])
}

export async function updateSafety(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('admin', async ({ db, workspace, user }) => {
    const f = formObject(fd)
    const id = Id.parse(f.id)
    const s = SafetySettings.parse({
      aiDisclosureMode: f.aiDisclosureMode, disclosureText: f.disclosureText, approvalMode: f.approvalMode,
      minAudienceAge: intField(f.minAudienceAge, 13), ageRestricted: boolField(f.ageRestricted), depictsRealPerson: boolField(f.depictsRealPerson),
      consentEvidencePath: f.consentEvidencePath,
    })
    const ok = await recordAudit({ workspaceId: workspace.id, actorType: 'user', actorId: user.id, action: 'character.update_safety', entityType: 'character', entityId: id, details: { ...s } })
    if (!ok) throw new Error('audit log unavailable; safety settings not changed')
    const up = await db.from('characters').update({
      ai_disclosure_mode: s.aiDisclosureMode, disclosure_text: s.disclosureText, approval_mode: s.approvalMode, min_audience_age: s.minAudienceAge,
      age_restricted: s.ageRestricted, depicts_real_person: s.depictsRealPerson, consent_evidence_path: s.consentEvidencePath ?? null,
    }).eq('workspace_id', workspace.id).eq('id', id)
    if (up.error) throw new Error(up.error.message)
  }, ['/characters'])
}

export async function updatePersonality(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace, user }) => {
    const f = formObject(fd)
    const id = Id.parse(f.id)
    const v = CharacterVoice.parse({
      personality: { traits: listField(f.traits), values: listField(f.values), quirks: listField(f.quirks), humor: f.humor },
      toneOfVoice: f.toneOfVoice, backstory: f.backstory,
    })
    const boundaries = ContentBoundaries.parse({ avoidTopics: listField(f.avoidTopics), sensitiveTopicsNeedReview: listField(f.sensitiveTopicsNeedReview), neverSay: listField(f.neverSay) })
    const platformStrategy = PlatformStrategy.parse({ platforms: listField(f.platforms).map(p => ({ platform: p, formats: [] })) })
    const monetisation = MonetisationStrategy.parse({ channels: listField(f.channels), notes: f.monetisationNotes, noGoCategories: listField(f.noGoCategories) })
    const up = await db.from('character_profiles').update({
      personality: v.personality as Json, tone_of_voice: v.toneOfVoice ?? null, backstory: v.backstory ?? null,
      content_boundaries: boundaries as Json, platform_strategy: platformStrategy as Json, monetisation_strategy: monetisation as Json,
    }).eq('workspace_id', workspace.id).eq('character_id', id)
    if (up.error) throw new Error(up.error.message)
    await recordAudit({ workspaceId: workspace.id, actorType: 'user', actorId: user.id, action: 'character.update_personality', entityType: 'character', entityId: id })
  }, ['/characters'])
}

export async function updateVisual(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace, user }) => {
    const f = formObject(fd)
    const id = Id.parse(f.id)
    const v = VisualIdentity.parse({
      appearanceDescription: f.appearanceDescription, styleKeywords: listField(f.styleKeywords), colorPalette: listField(f.colorPalette),
      cameraStyle: f.cameraStyle, promptPrefix: f.promptPrefix, negativePrompt: f.negativePrompt, doNotDepict: listField(f.doNotDepict),
    })
    const up = await db.from('character_visual_rules').update({
      appearance_description: v.appearanceDescription ?? null, style_keywords: v.styleKeywords, color_palette: v.colorPalette, camera_style: v.cameraStyle ?? null,
      prompt_prefix: v.promptPrefix ?? null, negative_prompt: v.negativePrompt ?? null, do_not_depict: v.doNotDepict,
    }).eq('workspace_id', workspace.id).eq('character_id', id)
    if (up.error) throw new Error(up.error.message)
    await recordAudit({ workspaceId: workspace.id, actorType: 'user', actorId: user.id, action: 'character.update_visual', entityType: 'character', entityId: id })
  }, ['/characters'])
}

export async function addBrandRule(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace, user }) => {
    const f = formObject(fd)
    const id = Id.parse(f.id)
    const r = BrandRule.parse({ ruleType: f.ruleType, rule: f.rule, priority: intField(f.priority, 3) })
    const ins = await db.from('character_brand_rules').insert({ workspace_id: workspace.id, character_id: id, rule_type: r.ruleType, rule: r.rule, priority: r.priority })
    if (ins.error) throw new Error(ins.error.message)
    await recordAudit({ workspaceId: workspace.id, actorType: 'user', actorId: user.id, action: 'character.add_brand_rule', entityType: 'character', entityId: id })
    return 'Rule added.'
  }, ['/characters'])
}

export async function toggleBrandRule(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace }) => {
    const ruleId = Id.parse(fd.get('ruleId'))
    const active = fd.get('active') === 'true'
    const up = await db.from('character_brand_rules').update({ active }).eq('workspace_id', workspace.id).eq('id', ruleId)
    if (up.error) throw new Error(up.error.message)
    return active ? 'Rule enabled.' : 'Rule disabled.'
  }, ['/characters'])
}

export async function saveContentPolicy(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('admin', async ({ db, workspace, user }) => {
    const f = formObject(fd)
    const id = Id.parse(f.id)
    const rules = ContentPolicyRules.parse({
      blockedTopics: listField(f.blockedTopics), reviewTerms: listField(f.reviewTerms),
      requireDisclaimerFor: listField(f.requireDisclaimerFor), maxRating: f.maxRating ?? 'general',
    })
    const stored = parsePolicy(rules)
    const ch = (await db.from('characters').select('name, content_policy_id').eq('workspace_id', workspace.id).eq('id', id).single()).data
    if (!ch) throw new Error('character not found')
    if (ch.content_policy_id) {
      const cur = (await db.from('content_policies').select('version').eq('id', ch.content_policy_id).single()).data
      const up = await db.from('content_policies').update({ rules: stored as Json, version: (cur?.version ?? 1) + 1 }).eq('workspace_id', workspace.id).eq('id', ch.content_policy_id)
      if (up.error) throw new Error(up.error.message)
    } else {
      const ins = await db.from('content_policies').insert({ workspace_id: workspace.id, name: `${ch.name} policy`, rules: stored as Json, created_by: user.id }).select('id').single()
      if (ins.error) throw new Error(ins.error.message)
      await db.from('characters').update({ content_policy_id: ins.data.id }).eq('workspace_id', workspace.id).eq('id', id)
    }
    await recordAudit({ workspaceId: workspace.id, actorType: 'user', actorId: user.id, action: 'character.update_content_policy', entityType: 'character', entityId: id, details: { rules: stored as unknown as Json } })
    return 'Content policy saved.'
  }, ['/characters'])
}

export async function addMemory(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace, user }) => {
    const f = formObject(fd)
    const id = Id.parse(f.id)
    const m = MemoryInput.parse({ kind: f.kind, content: f.content, importance: intField(f.importance, 3) })
    // Owner-entered memories are canon immediately.
    const ins = await db.from('character_memories').insert({ workspace_id: workspace.id, character_id: id, kind: m.kind, content: m.content, importance: m.importance, source: 'owner', is_canon: true, confirmed_by: user.id, confirmed_at: new Date().toISOString() })
    if (ins.error) throw new Error(ins.error.message)
    return 'Memory saved.'
  }, ['/characters'])
}

export async function confirmMemory(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace, user }) => {
    const memoryId = Id.parse(fd.get('memoryId'))
    const accept = fd.get('accept') === 'true'
    const q = accept
      ? db.from('character_memories').update({ is_canon: true, confirmed_by: user.id, confirmed_at: new Date().toISOString() })
      : db.from('character_memories').delete()
    const r = await q.eq('workspace_id', workspace.id).eq('id', memoryId).eq('is_canon', false)
    if (r.error) throw new Error(r.error.message)
    await recordAudit({ workspaceId: workspace.id, actorType: 'user', actorId: user.id, action: accept ? 'memory.confirm' : 'memory.reject', entityType: 'character_memory', entityId: memoryId })
    return accept ? 'Memory confirmed as canon.' : 'Memory discarded.'
  }, ['/characters'])
}

const AssetUpload = z.object({
  id: z.uuid(), bucket: z.enum(['character-assets', 'reference-images']), fileName: z.string().min(1).max(200),
  mimeType: z.string().max(100), bytes: z.number().int().positive(),
})

/** Step 1 of an upload: validates and returns a signed upload URL for a server-chosen path. */
export async function prepareAssetUpload(input: z.infer<typeof AssetUpload>): Promise<{ ok: true; path: string; token: string } | { ok: false; message: string }> {
  const r = { value: null as null | { path: string; token: string } }
  const res = await runAction('editor', async ({ db, workspace }) => {
    const a = AssetUpload.parse(input)
    const ch = (await db.from('characters').select('id').eq('workspace_id', workspace.id).eq('id', a.id).maybeSingle()).data
    if (!ch) throw new Error('character not found')
    const v = validateUpload(a.bucket, a.mimeType, a.bytes)
    if (!v.ok) throw new Error(v.reason)
    const path = buildObjectPath(workspace.id, a.id, a.fileName)
    const signed = await createSignedUpload(db, { workspaceId: workspace.id, bucket: a.bucket, path, mimeType: a.mimeType, bytes: a.bytes })
    r.value = { path: signed.path, token: signed.token }
  })
  return res?.ok && r.value ? { ok: true, ...r.value } : { ok: false, message: res?.message ?? 'failed' }
}

const AssetConfirm = AssetUpload.extend({
  path: z.string().max(500), kind: z.enum(['avatar', 'reference_image', 'style_guide', 'voice_sample', 'logo', 'consent_evidence', 'other']),
  provenance: z.enum(['owned', 'licensed', 'ai_generated']), rightsNotes: z.string().max(1000).optional(), depictsRealPerson: z.boolean().default(false),
})

/** Step 2: records the uploaded file after checking it actually exists in Storage. */
export async function confirmAssetUpload(input: z.infer<typeof AssetConfirm>): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace, user }) => {
    const a = AssetConfirm.parse(input)
    if (!a.path.startsWith(`${workspace.id}/${a.id}/`)) throw new Error('path outside this character')
    const exists = await db.storage.from(a.bucket as BucketId).exists(a.path)
    if (!exists.data) throw new Error('upload not found in storage')
    if (a.depictsRealPerson) {
      const ch = (await db.from('characters').select('consent_evidence_path').eq('id', a.id).single()).data
      if (!ch?.consent_evidence_path) throw new Error('assets depicting a real person need consent evidence on the character first')
    }
    const ins = await db.from('character_assets').insert({
      workspace_id: workspace.id, character_id: a.id, kind: a.kind, storage_bucket: a.bucket, storage_path: a.path, file_name: a.fileName.slice(0, 200),
      mime_type: a.mimeType, bytes: a.bytes, provenance: a.provenance, rights_notes: a.rightsNotes ?? null, depicts_real_person: a.depictsRealPerson,
      status: 'ready', uploaded_by: user.id,
    })
    if (ins.error) throw new Error(ins.error.message)
    await recordAudit({ workspaceId: workspace.id, actorType: 'user', actorId: user.id, action: 'character.asset_upload', entityType: 'character', entityId: a.id, details: { kind: a.kind, bytes: a.bytes } })
    return 'Asset uploaded.'
  }, ['/characters'])
}

export async function deleteAsset(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace, user }) => {
    const assetId = Id.parse(fd.get('assetId'))
    const a = (await db.from('character_assets').select('storage_bucket, storage_path').eq('workspace_id', workspace.id).eq('id', assetId).single()).data
    if (!a) throw new Error('asset not found')
    await db.storage.from(a.storage_bucket).remove([a.storage_path])
    await db.from('character_assets').update({ status: 'deleted' }).eq('workspace_id', workspace.id).eq('id', assetId)
    await recordAudit({ workspaceId: workspace.id, actorType: 'user', actorId: user.id, action: 'character.asset_delete', entityType: 'character_asset', entityId: assetId })
    return 'Asset deleted.'
  }, ['/characters'])
}
