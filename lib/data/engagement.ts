import 'server-only'
import { createClient } from '@/lib/supabase/server'

export async function engagementFor(characterId: string, opts: { kinds?: ('comment' | 'mention' | 'dm' | 'reply')[]; statuses?: ('new' | 'needs_reply' | 'replied' | 'ignored' | 'hidden' | 'escalated')[] } = {}) {
  const supabase = await createClient()
  let q = supabase.from('engagement_items').select('*').eq('character_id', characterId).order('received_at', { ascending: false }).limit(100)
  if (opts.kinds) q = q.in('kind', opts.kinds)
  if (opts.statuses) q = q.in('status', opts.statuses)
  return (await q).data ?? []
}
