import { createClient } from '@/lib/supabase/server'
import { selectedCharacter } from '@/lib/data/characters'
import { daysAgo, engagementRate, followerGrowth, formatCount, formatPct, latestPerDay, totals, type DailyRow } from '@/lib/analytics/metrics'
import { PageHeader, Panel } from '@/components/shell/page-header'
import { CharacterFilter, NoCharacters } from '@/components/shell/character-filter'
import { ActionForm, Field, Select, SubmitButton, Textarea } from '@/components/ui/form'
import { EmptyState, Stat } from '@/components/ui/table'
import { importAccountMetrics } from './actions'

export const dynamic = 'force-dynamic'

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ character?: string }> }) {
  const { all, current } = await selectedCharacter((await searchParams).character)
  if (!current) return <><PageHeader title="Analytics" /><NoCharacters /></>
  const supabase = await createClient()
  const since = daysAgo(28)
  const [{ data: daily }, { data: accounts }] = await Promise.all([
    supabase.from('analytics_daily').select('*').eq('character_id', current.id).gte('day', since).order('day'),
    supabase.from('social_accounts').select('id, platform, handle, status').eq('character_id', current.id),
  ])
  const rows = latestPerDay(daily ?? [], r => r.social_account_id) as unknown as DailyRow[]
  const t = totals(rows)
  const growth = followerGrowth(rows)
  const max = Math.max(1, ...rows.map(r => r.reach ?? r.views ?? 0))
  return (
    <>
      <PageHeader title="Analytics" description="Last 28 days, from platform APIs or your own imports. Nothing is estimated: missing data shows as —." />
      <CharacterFilter path="/growth" characters={all} current={current.id} />
      {rows.length === 0 ? (
        <EmptyState>No account metrics yet. Post metrics sync automatically once published; account-level metrics can be imported below from each platform&apos;s analytics export.</EmptyState>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Reach" value={formatCount(t.reach)} />
            <Stat label="Views" value={formatCount(t.views)} />
            <Stat label="Engagement rate" value={formatPct(engagementRate(t))} hint="interactions ÷ reach" />
            <Stat label="Follower change" value={growth ? `${growth.change >= 0 ? '+' : ''}${growth.change}` : '—'} hint={growth ? formatPct(growth.pct) : 'needs two days of follower counts'} />
          </div>
          <Panel title="Daily reach / views" className="mb-4">
            <div className="flex h-32 items-end gap-1" role="img" aria-label="Daily reach bar chart">
              {rows.map(r => <div key={`${r.day}`} title={`${r.day}: ${r.reach ?? r.views ?? 'no data'}`} className="flex-1 rounded-t bg-cyan-700/70" style={{ height: `${((r.reach ?? r.views ?? 0) / max) * 100}%`, minHeight: (r.reach ?? r.views) === null ? 0 : 2 }} />)}
            </div>
          </Panel>
        </>
      )}
      {(accounts ?? []).length > 0 && (
        <Panel title="Import account metrics (CSV)">
          <ActionForm action={importAccountMetrics}>
            <Field label="Account"><Select name="socialAccountId" options={(accounts ?? []).map(a => ({ value: a.id, label: `${a.platform} @${a.handle ?? '—'}` }))} /></Field>
            <Field label="CSV" hint="Header row, then one row per day. Columns: day,followers,reach,impressions,views,likes,comments,shares,saves (any subset; day required).">
              <Textarea name="csv" rows={5} className="font-mono text-xs" placeholder={'day,followers,reach,likes\n2026-09-01,1200,5400,310'} />
            </Field>
            <SubmitButton>Import</SubmitButton>
          </ActionForm>
        </Panel>
      )}
    </>
  )
}
