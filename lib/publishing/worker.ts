import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json, PublishingJobRow } from '@/types/database'
import { getSocialProvider } from '@/lib/social/providers'
import type { Env, FetchFn, PublishMedia } from '@/lib/social/providers/types'
import { loadTokens } from '@/lib/social/tokens'
import { PUBLISH_URL_TTL } from '@/lib/storage/buckets'
import { attemptPublish, type AttemptOutcome } from './attempt'

type Db = SupabaseClient<Database>

/**
 * Publishing cycle (called by /api/cron/publish). Safe to run concurrently and
 * repeatedly: jobs are claimed with SKIP LOCKED, each job has a unique
 * idempotency key, only one success per job can be recorded, and a unique
 * index forbids two live jobs for the same content + account.
 */
export async function runPublishingCycle(db: Db, env: Env, f: FetchFn, limit = 5) {
  const reaped = await db.rpc('reap_stuck_publishing_jobs', {})
  const claimed = await db.rpc('claim_publishing_jobs', { p_limit: limit })
  if (claimed.error) throw new Error(`claim jobs: ${claimed.error.message}`)
  const results: { jobId: string; outcome: AttemptOutcome['kind'] }[] = []
  for (const job of claimed.data ?? []) {
    let outcome: AttemptOutcome
    try {
      outcome = await publishJob(db, job, env, f)
    } catch (e) {
      outcome = { kind: 'retry', error: (e as Error).message.slice(0, 1000) }
    }
    await finish(db, job, outcome)
    results.push({ jobId: job.id, outcome: outcome.kind })
  }
  return { reaped: reaped.data ?? 0, processed: results }
}

async function publishJob(db: Db, job: PublishingJobRow, env: Env, f: FetchFn): Promise<AttemptOutcome> {
  const ws = job.workspace_id
  const item = (await db.from('content_items').select('*').eq('workspace_id', ws).eq('id', job.content_item_id).single()).data
  if (!item) return { kind: 'blocked', reasons: ['Content item no longer exists.'] }
  const [version, account, character, policies, assets, approval, recent] = await Promise.all([
    db.from('content_versions').select('version, caption, script, hashtags').eq('workspace_id', ws).eq('content_item_id', item.id).eq('version', item.current_version).maybeSingle(),
    db.from('social_accounts').select('status, platform, character_id').eq('workspace_id', ws).eq('id', job.social_account_id).single(),
    db.from('characters').select('status, approval_mode, ai_disclosure_mode, disclosure_text').eq('workspace_id', ws).eq('id', item.character_id).single(),
    db.from('publishing_policies').select('*').eq('workspace_id', ws).eq('platform', job.platform),
    db.from('content_assets').select('kind, storage_bucket, storage_path, mime_type, bytes').eq('workspace_id', ws).eq('content_item_id', item.id).eq('status', 'ready').order('created_at'),
    job.approval_id ? db.from('agent_approvals').select('payload, result, status').eq('id', job.approval_id).single() : Promise.resolve({ data: null }),
    db.from('publishing_jobs').select('updated_at').eq('workspace_id', ws).eq('social_account_id', job.social_account_id).eq('status', 'succeeded')
      .gte('updated_at', new Date(Date.now() - 86_400_000).toISOString()).order('updated_at', { ascending: false }),
  ])
  if (!account.data || !character.data) return { kind: 'blocked', reasons: ['Account or character missing.'] }
  // Character-specific policy wins over the platform default. No policy → publishing disabled.
  const policy = (policies.data ?? []).find(p => p.character_id === item.character_id) ?? (policies.data ?? []).find(p => p.character_id === null)
  if (!policy) return { kind: 'blocked', reasons: [`No publishing policy for ${job.platform}; publishing is disabled by default.`] }

  const media: PublishMedia[] = []
  for (const a of assets.data ?? []) {
    if (a.kind !== 'image' && a.kind !== 'video') continue
    const s = await db.storage.from(a.storage_bucket).createSignedUrl(a.storage_path, PUBLISH_URL_TTL)
    if (s.error) return { kind: 'retry', error: `signed URL: ${s.error.message}` }
    media.push({ kind: a.kind, url: s.data.signedUrl, mimeType: a.mime_type, bytes: a.bytes ?? undefined })
  }
  // The version a human approved: in the payload (user requests) or pinned in the result at approval time (agent requests).
  const approvedVersion = (approval.data?.payload as { version?: number } | null)?.version ?? (approval.data?.result as { version?: number } | null)?.version ?? null
  const provider = getSocialProvider(job.platform)
  const posts = recent.data ?? []

  await db.from('content_items').update({ status: 'publishing' }).eq('workspace_id', ws).eq('id', item.id).eq('status', 'scheduled')
  return attemptPublish({
    job, item: { ...item, status: item.status === 'scheduled' ? 'publishing' : item.status }, version: version.data ?? null, approvedVersion, media,
    account: account.data, policy, character: character.data, postsInLast24h: posts.length,
    lastPostAt: posts[0] ? new Date(posts[0].updated_at) : null, provider,
    tokens: () => loadTokens(db, { workspaceId: ws, socialAccountId: job.social_account_id, provider: provider!, env, fetch: f }),
  }, env, f)
}

async function finish(db: Db, job: PublishingJobRow, o: AttemptOutcome) {
  if (o.kind === 'published') {
    const r = await db.rpc('complete_publishing_job', { p_job_id: job.id, p_success: true, p_external_post_id: o.externalPostId, p_url: o.url, p_response: o.summary as Json })
    if (r.error) throw new Error(`complete job: ${r.error.message}`)
    if (job.approval_id) await db.from('agent_approvals').update({ status: 'COMPLETED', result: { externalPostId: o.externalPostId, url: o.url } as Json }).eq('id', job.approval_id).eq('status', 'EXECUTING')
  } else if (o.kind === 'retry') {
    const r = await db.rpc('complete_publishing_job', { p_job_id: job.id, p_success: false, p_error: o.error })
    if (r.error) throw new Error(`complete job: ${r.error.message}`)
    if (r.data?.status === 'failed') {
      if (job.approval_id) await db.from('agent_approvals').update({ status: 'FAILED', error: o.error.slice(0, 2000) }).eq('id', job.approval_id).eq('status', 'EXECUTING')
    } else {
      await db.from('content_items').update({ status: 'scheduled' }).eq('workspace_id', job.workspace_id).eq('id', job.content_item_id).eq('status', 'publishing')
    }
  } else {
    const error = o.reasons.join(' ').slice(0, 2000)
    await db.from('publishing_jobs').update({ status: 'blocked', locked_at: null, last_error: error }).eq('id', job.id).eq('status', 'running')
    await db.from('content_items').update({ status: 'failed' }).eq('workspace_id', job.workspace_id).eq('id', job.content_item_id).in('status', ['scheduled', 'publishing'])
    if (job.approval_id) await db.from('agent_approvals').update({ status: 'FAILED', error }).eq('id', job.approval_id).eq('status', 'EXECUTING')
  }
}
