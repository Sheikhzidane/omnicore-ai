import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { recordAudit } from '@/lib/audit'
import type { ImageProvider } from '@/lib/ai/types'
import { buildObjectPath } from '@/lib/storage/buckets'
import { uploadBytes } from '@/lib/storage/server'
import type { Actor } from './service'

type Db = SupabaseClient<Database>

/**
 * Generates an image for a content item from its current image prompt plus the
 * character's visual rules, stores it in the private generated-content bucket
 * and records provenance (ai_generated, provider, prompt).
 */
export async function generateImageForItem(db: Db, a: Actor, itemId: string, provider: ImageProvider) {
  const ws = a.workspaceId
  const item = (await db.from('content_items').select('id, character_id, current_version, status').eq('workspace_id', ws).eq('id', itemId).single()).data
  if (!item) throw new Error('content not found')
  if (!['draft', 'in_review', 'rejected', 'failed'].includes(item.status)) throw new Error(`content is ${item.status}`)
  const [v, vis] = await Promise.all([
    db.from('content_versions').select('image_prompt, caption').eq('workspace_id', ws).eq('content_item_id', itemId).eq('version', item.current_version).maybeSingle(),
    db.from('character_visual_rules').select('prompt_prefix, negative_prompt, do_not_depict, style_keywords').eq('workspace_id', ws).eq('character_id', item.character_id).maybeSingle(),
  ])
  const base = v.data?.image_prompt
  if (!base) throw new Error('add an image prompt first (write one, or ask the Image Prompt agent)')
  const prompt = [vis.data?.prompt_prefix, base, vis.data?.style_keywords?.length ? `Style: ${vis.data.style_keywords.join(', ')}` : null,
    'Fictional character; do not depict any real, identifiable person.'].filter(Boolean).join('\n').slice(0, 3900)
  const negative = [vis.data?.negative_prompt, ...(vis.data?.do_not_depict ?? [])].filter(Boolean).join(', ') || undefined

  const out = await provider.generate({ prompt, negativePrompt: negative, size: '1024x1024', count: 1 })
  const img = out.images[0]
  if (!img) throw new Error('the provider returned no image')
  const ext = img.mimeType === 'image/jpeg' ? 'jpg' : img.mimeType === 'image/webp' ? 'webp' : 'png'
  const path = buildObjectPath(ws, item.character_id, `generated.${ext}`)
  const bytes = Uint8Array.from(Buffer.from(img.base64, 'base64'))
  await uploadBytes(db, { workspaceId: ws, bucket: 'generated-content', path, mimeType: img.mimeType, data: bytes })
  const ins = await db.from('content_assets').insert({
    workspace_id: ws, character_id: item.character_id, content_item_id: item.id, kind: 'image', storage_bucket: 'generated-content', storage_path: path,
    mime_type: img.mimeType, bytes: bytes.byteLength, provenance: 'ai_generated', generation_provider: `${out.provider}:${out.model}`, prompt: prompt.slice(0, 4000), status: 'ready',
  }).select('id').single()
  if (ins.error) throw new Error(ins.error.message)
  if (out.costUsd && out.costUsd > 0) {
    await db.from('expenses').insert({ workspace_id: ws, character_id: item.character_id, category: 'ai_compute', vendor: out.model, amount_cents: Math.round(out.costUsd * 100), currency: 'USD', occurred_on: new Date().toISOString().slice(0, 10), description: `Image generation for content ${item.id}` })
  }
  await recordAudit({ workspaceId: ws, actorType: 'user', actorId: a.userId, action: 'content.generate_image', entityType: 'content_item', entityId: item.id, details: { provider: out.provider, model: out.model } })
  return ins.data.id
}
