import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { getSocialProvider } from '@/lib/social/providers'
import type { Env, FetchFn } from '@/lib/social/providers/types'
import { loadTokens } from '@/lib/social/tokens'

type Db = SupabaseClient<Database>

/**
 * Pulls post metrics for content published in the last 30 days from each
 * platform's API and stores one snapshot per post per day (source
 * 'platform_api'). Failures are recorded on the account, never papered over.
 */
export async function syncContentMetrics(db: Db, env: Env, f: FetchFn, limit = 25) {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const results = await db.from('publishing_results').select('workspace_id, external_post_id, publishing_job_id, created_at')
    .eq('status', 'success').gte('created_at', since).order('created_at', { ascending: false }).limit(limit)
  if (results.error) throw new Error(results.error.message)
  const day = new Date().toISOString().slice(0, 10)
  let synced = 0
  const errors: string[] = []
  for (const r of results.data ?? []) {
    if (!r.external_post_id) continue
    const job = (await db.from('publishing_jobs').select('content_item_id, social_account_id, platform').eq('id', r.publishing_job_id).single()).data
    if (!job) continue
    const provider = getSocialProvider(job.platform)
    if (!provider?.capabilities.metrics || !provider.configured(env)) continue
    try {
      const tokens = await loadTokens(db, { workspaceId: r.workspace_id, socialAccountId: job.social_account_id, provider, env, fetch: f })
      const m = await provider.fetchPostMetrics(tokens, r.external_post_id, f)
      const up = await db.from('content_metrics').upsert({
        workspace_id: r.workspace_id, content_item_id: job.content_item_id, social_account_id: job.social_account_id, platform: job.platform, day,
        views: m.views ?? null, reach: m.reach ?? null, impressions: m.impressions ?? null, likes: m.likes ?? null, comments: m.comments ?? null,
        shares: m.shares ?? null, saves: m.saves ?? null, source: 'platform_api', captured_at: new Date().toISOString(),
      }, { onConflict: 'content_item_id,social_account_id,day' })
      if (up.error) throw new Error(up.error.message)
      synced++
    } catch (e) {
      const msg = `${job.platform}: ${(e as Error).message}`.slice(0, 500)
      errors.push(msg)
      await db.from('social_accounts').update({ last_error: msg }).eq('id', job.social_account_id)
    }
  }
  return { synced, errors }
}
