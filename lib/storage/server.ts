import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { SIGNED_URL_TTL, pathBelongsTo, validateUpload, type BucketId } from './buckets'

type Db = SupabaseClient<Database>

/**
 * Server-mediated storage. Callers must have authorised the user for
 * `workspaceId` (requireWorkspace) before calling; these helpers additionally
 * refuse any path outside that workspace's folder.
 */

export async function createSignedUpload(db: Db, p: { workspaceId: string; bucket: BucketId; path: string; mimeType: string; bytes: number }) {
  if (!pathBelongsTo(p.path, p.workspaceId)) throw new Error('path outside workspace')
  const v = validateUpload(p.bucket, p.mimeType, p.bytes)
  if (!v.ok) throw new Error(v.reason)
  const r = await db.storage.from(p.bucket).createSignedUploadUrl(p.path)
  if (r.error) throw new Error(`signed upload: ${r.error.message}`)
  return { path: r.data.path, token: r.data.token, signedUrl: r.data.signedUrl }
}

export async function createSignedDownload(db: Db, p: { workspaceId: string; bucket: BucketId; path: string; ttl?: number }) {
  if (!pathBelongsTo(p.path, p.workspaceId)) throw new Error('path outside workspace')
  const r = await db.storage.from(p.bucket).createSignedUrl(p.path, p.ttl ?? SIGNED_URL_TTL)
  if (r.error) throw new Error(`signed url: ${r.error.message}`)
  return r.data.signedUrl
}

export async function uploadBytes(db: Db, p: { workspaceId: string; bucket: BucketId; path: string; mimeType: string; data: Uint8Array }) {
  if (!pathBelongsTo(p.path, p.workspaceId)) throw new Error('path outside workspace')
  const v = validateUpload(p.bucket, p.mimeType, p.data.byteLength)
  if (!v.ok) throw new Error(v.reason)
  const r = await db.storage.from(p.bucket).upload(p.path, p.data, { contentType: p.mimeType, upsert: false })
  if (r.error) throw new Error(`upload: ${r.error.message}`)
}

export async function removeObject(db: Db, p: { workspaceId: string; bucket: BucketId; path: string }) {
  if (!pathBelongsTo(p.path, p.workspaceId)) throw new Error('path outside workspace')
  const r = await db.storage.from(p.bucket).remove([p.path])
  if (r.error) throw new Error(`remove: ${r.error.message}`)
}
