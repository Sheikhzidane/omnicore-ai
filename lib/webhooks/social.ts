import type { ParsedWebhookEvent } from '@/lib/social/providers/types'

/**
 * Maps verified platform webhook events to engagement inbox rows. Pure — the
 * route handler resolves the account and performs the inserts.
 */
export interface EngagementDraft {
  kind: 'comment' | 'mention' | 'reply'
  externalId: string
  parentExternalId: string | null
  authorHandle: string | null
  authorExternalId: string | null
  body: string
}

export function toEngagement(platform: string, e: ParsedWebhookEvent): EngagementDraft | null {
  const p = e.payload as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' && v.length ? v : null)
  if (platform === 'instagram' && (e.eventType === 'comments' || e.eventType === 'live_comments')) {
    const from = (p.from ?? {}) as Record<string, unknown>
    const text = str(p.text), id = str(p.id)
    if (!text || !id) return null
    return { kind: 'comment', externalId: id, parentExternalId: str((p.media as Record<string, unknown> | undefined)?.id) ?? str(p.parent_id), authorHandle: str(from.username), authorExternalId: str(from.id), body: text.slice(0, 5000) }
  }
  if (platform === 'instagram' && e.eventType === 'mentions') {
    const id = str(p.comment_id) ?? str(p.media_id)
    if (!id) return null
    return { kind: 'mention', externalId: id, parentExternalId: str(p.media_id), authorHandle: null, authorExternalId: null, body: '(mention — open on Instagram to view)' }
  }
  if (platform === 'x' && e.eventType === 'tweet_create') {
    const id = str(p.id), text = str(p.text)
    // Ignore the character's own posts.
    if (!id || !text || str(p.authorId) === e.externalAccountId) return null
    return { kind: p.inReplyTo ? 'reply' : 'mention', externalId: id, parentExternalId: str(p.inReplyTo), authorHandle: str(p.author), authorExternalId: str(p.authorId), body: text.slice(0, 5000) }
  }
  return null
}
