'use server'

import { z } from 'zod'
import { recordAudit } from '@/lib/audit'
import { runAction, formObject, listField, type ActionResult } from '@/lib/actions'
import { queueAgentTask, describeOutcome } from '@/lib/agents/runner'
import { totals, followerGrowth, type DailyRow } from '@/lib/analytics/metrics'

const Id = z.uuid()
const n = (v: string | undefined) => (v === undefined || v.trim() === '' ? null : z.coerce.number().int().min(0).parse(v))

/**
 * Owner import of account metrics exported from the platform's own analytics
 * (source = 'manual_import'). Header row required; blank cells stay null.
 */
export async function importAccountMetrics(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace, user }) => {
    const f = formObject(fd)
    const accountId = Id.parse(f.socialAccountId)
    const acct = (await db.from('social_accounts').select('id, platform, character_id').eq('workspace_id', workspace.id).eq('id', accountId).single()).data
    if (!acct) throw new Error('account not found')
    const lines = String(f.csv ?? '').trim().split(/\r?\n/)
    const header = lines.shift()?.split(',').map(h => h.trim().toLowerCase()) ?? []
    if (!header.includes('day')) throw new Error('first row must be a header including "day"')
    const cols = ['followers', 'following', 'reach', 'impressions', 'views', 'likes', 'comments', 'shares', 'saves', 'profile_visits', 'link_clicks'] as const
    const rows = lines.filter(Boolean).slice(0, 1000).map((line, i) => {
      const cells = line.split(',').map(c => c.trim())
      const get = (k: string) => { const idx = header.indexOf(k); return idx === -1 ? undefined : cells[idx] }
      const day = get('day') ?? ''
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`row ${i + 2}: day must be YYYY-MM-DD`)
      const row: Record<string, unknown> = { workspace_id: workspace.id, character_id: acct.character_id, social_account_id: acct.id, platform: acct.platform, day, source: 'manual_import' }
      for (const c of cols) row[c] = n(get(c))
      return row
    })
    if (!rows.length) throw new Error('no data rows')
    const up = await db.from('analytics_daily').upsert(rows as never, { onConflict: 'social_account_id,day' })
    if (up.error) throw new Error(up.error.message)
    await recordAudit({ workspaceId: workspace.id, actorType: 'user', actorId: user.id, action: 'analytics.import', entityType: 'social_account', entityId: acct.id, details: { rows: rows.length } })
    return `Imported ${rows.length} day(s).`
  }, ['/growth'])
}

export async function importAudience(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace }) => {
    const f = formObject(fd)
    const accountId = Id.parse(f.socialAccountId)
    const acct = (await db.from('social_accounts').select('id').eq('workspace_id', workspace.id).eq('id', accountId).single()).data
    if (!acct) throw new Error('account not found')
    const rows = String(f.csv ?? '').trim().split(/\r?\n/).slice(1).filter(Boolean).slice(0, 2000).map((line, i) => {
      const [day, dimension, bucket, value] = line.split(',').map(c => c.trim())
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '')) throw new Error(`row ${i + 2}: day must be YYYY-MM-DD`)
      return {
        workspace_id: workspace.id, social_account_id: acct.id, day,
        dimension: z.enum(['age', 'gender', 'country', 'city', 'language', 'device']).parse(dimension), bucket: z.string().min(1).max(100).parse(bucket),
        value: z.coerce.number().min(0).parse(value), source: 'manual_import' as const,
      }
    })
    if (!rows.length) throw new Error('no data rows (header: day,dimension,bucket,value)')
    const up = await db.from('audience_metrics').upsert(rows, { onConflict: 'social_account_id,day,dimension,bucket' })
    if (up.error) throw new Error(up.error.message)
    return `Imported ${rows.length} row(s).`
  }, ['/growth/audience'])
}

export async function runTrendAnalysis(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace, user }) => {
    const f = formObject(fd)
    const characterId = Id.parse(f.characterId)
    const signals = listField(String(f.signals ?? '').replace(/,/g, '\n')).slice(0, 50)
    if (!signals.length) throw new Error('paste at least one trend signal')
    const r = await queueAgentTask(db, process.env, { workspaceId: workspace.id, characterId, role: 'trend_research', type: 'trend_analysis', title: 'Trend analysis', input: { signals, platforms: [] }, userId: user.id, runNow: true })
    return describeOutcome(r.outcome)
  }, ['/growth/trends'])
}

/** Builds the growth report input from REAL stored metrics only. */
export async function runGrowthReport(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace, user }) => {
    const characterId = Id.parse(fd.get('characterId'))
    const periodDays = 28
    const since = new Date(Date.now() - periodDays * 86_400_000).toISOString().slice(0, 10)
    const [{ data: daily }, { data: content }] = await Promise.all([
      db.from('analytics_daily').select('platform, day, followers, reach, impressions, views, likes, comments, shares, saves').eq('workspace_id', workspace.id).eq('character_id', characterId).gte('day', since),
      db.from('content_metrics').select('content_item_id, platform, views, likes, comments, shares').eq('workspace_id', workspace.id).gte('day', since),
    ])
    const byPlatform: Record<string, unknown> = {}
    for (const p of [...new Set((daily ?? []).map(d => d.platform))]) {
      const rows = (daily ?? []).filter(d => d.platform === p) as DailyRow[]
      byPlatform[p] = { totals: totals(rows), followerGrowth: followerGrowth(rows) }
    }
    const metrics = { period: `${since} to today`, accounts: byPlatform, contentSnapshots: (content ?? []).length, contentSample: (content ?? []).slice(0, 50) }
    const r = await queueAgentTask(db, process.env, { workspaceId: workspace.id, characterId, role: 'growth_analyst', type: 'growth_report', title: 'Growth report (28 days)', input: { metrics, periodDays }, userId: user.id, runNow: true })
    return describeOutcome(r.outcome)
  }, ['/growth/recommendations'])
}

export async function runWeeklyStrategy(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace, user }) => {
    const f = formObject(fd)
    const characterId = Id.parse(f.characterId)
    const r = await queueAgentTask(db, process.env, { workspaceId: workspace.id, characterId, role: 'ceo', type: 'weekly_strategy', title: 'Weekly strategy', input: { ...(f.focus ? { focus: String(f.focus).slice(0, 1000) } : {}) }, userId: user.id, runNow: true })
    return `${describeOutcome(r.outcome)} Delegated tasks appear in AI Agents → Tasks for your approval.`
  }, ['/growth/recommendations', '/agents/tasks'])
}
