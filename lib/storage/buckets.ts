import { randomUUID } from 'node:crypto'

/**
 * Storage bucket rules — mirror of supabase/migrations/20260924000200_storage.sql.
 * The bucket settings enforce size/MIME in Storage itself; the app re-checks
 * here before issuing a signed upload URL so users get a clear error early.
 */

export const BUCKETS = {
  'character-assets': { maxBytes: 20 * 1024 * 1024, mime: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'audio/mpeg', 'audio/wav', 'application/pdf'] },
  'reference-images': { maxBytes: 20 * 1024 * 1024, mime: ['image/png', 'image/jpeg', 'image/webp'] },
  'generated-content': { maxBytes: 500 * 1024 * 1024, mime: ['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm', 'audio/mpeg', 'audio/wav'] },
  'campaign-assets': { maxBytes: 100 * 1024 * 1024, mime: ['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'application/pdf'] },
} as const

export type BucketId = keyof typeof BUCKETS

/** Signed download URLs live this long (seconds). */
export const SIGNED_URL_TTL = 300
/** Platforms fetching media for publishing get a longer window. */
export const PUBLISH_URL_TTL = 3600

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file'
  const clean = base.normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/^[.-]+/, '').replace(/-+/g, '-').slice(-100)
  return clean || 'file'
}

/** <workspace>/<owner (character or campaign)>/<uuid>-<name>. Never contains "..". */
export function buildObjectPath(workspaceId: string, ownerId: string, fileName: string, id = randomUUID()): string {
  if (!UUID.test(workspaceId) || !UUID.test(ownerId)) throw new Error('workspace and owner ids must be UUIDs')
  return `${workspaceId}/${ownerId}/${id}-${sanitizeFileName(fileName)}`
}

export function pathBelongsTo(path: string, workspaceId: string): boolean {
  return path.startsWith(`${workspaceId}/`) && !/(^|\/)\.\.(\/|$)/.test(path)
}

export type UploadCheck = { ok: true } | { ok: false; reason: string }

export function validateUpload(bucket: BucketId, mimeType: string, bytes: number): UploadCheck {
  const b = BUCKETS[bucket]
  if (!b) return { ok: false, reason: 'unknown bucket' }
  if (!(b.mime as readonly string[]).includes(mimeType)) return { ok: false, reason: `${mimeType} is not allowed in ${bucket}` }
  if (!Number.isInteger(bytes) || bytes <= 0) return { ok: false, reason: 'file is empty' }
  if (bytes > b.maxBytes) return { ok: false, reason: `file exceeds ${Math.round(b.maxBytes / 1024 / 1024)} MB` }
  return { ok: true }
}

export const mediaKind = (mime: string): 'image' | 'video' | 'audio' | 'document' =>
  mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'document'
