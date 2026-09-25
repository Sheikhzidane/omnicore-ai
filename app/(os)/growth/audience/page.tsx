import { createClient } from '@/lib/supabase/server'
import { selectedCharacter } from '@/lib/data/characters'
import { followerGrowth, type DailyRow } from '@/lib/analytics/metrics'
import { PageHeader, Panel } from '@/components/shell/page-header'
import { CharacterFilter, NoCharacters } from '@/components/shell/character-filter'
import { ActionForm, Field, Select, SubmitButton, Textarea } from '@/components/ui/form'
import { EmptyState } from '@/components/ui/table'
import { importAudience } from '../actions'

export const dynamic = 'force-dynamic'

export default async function AudienceGrowth({ searchParams }: { searchParams: Promise<{ character?: string }> }) {
  const { all, current } = await selectedCharacter((await searchParams).character)
  if (!current) return <><PageHeader title="Audience Growth" /><NoCharacters /></>
  const supabase = await createClient()
  const { data: accounts } = await supabase.from('social_accounts').select('id, platform, handle').eq('character_id', current.id)
  const ids = (accounts ?? []).map(a => a.id)
  const [{ data: daily }, { data: audience }] = ids.length ? await Promise.all([
    supabase.from('analytics_daily').select('social_account_id, day, followers').in('social_account_id', ids).not('followers', 'is', null).order('day'),
    supabase.from('audience_metrics').select('*').in('social_account_id', ids).order('day', { ascending: false }).limit(500),
  ]) : [{ data: [] }, { data: [] }]
  const latestDay = audience?.[0]?.day
  const latest = (audience ?? []).filter(a => a.day === latestDay)
  return (
    <>
      <PageHeader title="Audience Growth" description="Follower counts over time and audience breakdowns — only from platform data or your imports." />
      <CharacterFilter path="/growth/audience" characters={all} current={current.id} />
      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        {(accounts ?? []).map(a => {
          const rows = (daily ?? []).filter(d => d.social_account_id === a.id)
          const g = followerGrowth(rows as unknown as DailyRow[])
          const max = Math.max(1, ...rows.map(r => r.followers ?? 0))
          return (
            <Panel key={a.id} title={`${a.platform} @${a.handle ?? '—'}`}>
              {rows.length < 2 ? <p className="text-sm text-slate-500">Not enough follower data.</p> : (
                <>
                  <p className="mb-2 text-sm text-slate-300">{g!.start} → {g!.end} ({g!.change >= 0 ? '+' : ''}{g!.change})</p>
                  <div className="flex h-24 items-end gap-0.5" role="img" aria-label="Follower trend">{rows.map(r => <div key={r.day} title={`${r.day}: ${r.followers}`} className="flex-1 bg-emerald-700/70" style={{ height: `${((r.followers ?? 0) / max) * 100}%` }} />)}</div>
                </>
              )}
            </Panel>
          )
        })}
      </div>
      <Panel title={latestDay ? `Audience breakdown (${latestDay})` : 'Audience breakdown'} className="mb-4">
        {latest.length === 0 ? <EmptyState>No audience data.</EmptyState> : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[...new Set(latest.map(l => l.dimension))].map(dim => (
              <div key={dim}><p className="mb-1 text-xs uppercase text-slate-500">{dim}</p>
                <ul className="space-y-1 text-sm">{latest.filter(l => l.dimension === dim).sort((a, b) => b.value - a.value).slice(0, 8).map(l => <li key={l.id} className="flex justify-between"><span>{l.bucket}</span><span className="text-slate-400">{l.value}</span></li>)}</ul>
              </div>
            ))}
          </div>
        )}
      </Panel>
      {(accounts ?? []).length > 0 && (
        <Panel title="Import audience breakdown (CSV)">
          <ActionForm action={importAudience}>
            <Field label="Account"><Select name="socialAccountId" options={(accounts ?? []).map(a => ({ value: a.id, label: `${a.platform} @${a.handle ?? '—'}` }))} /></Field>
            <Field label="CSV" hint="Header row: day,dimension,bucket,value — dimension is one of age, gender, country, city, language, device.">
              <Textarea name="csv" rows={4} className="font-mono text-xs" placeholder={'day,dimension,bucket,value\n2026-09-01,country,GB,0.42'} />
            </Field>
            <SubmitButton>Import</SubmitButton>
          </ActionForm>
        </Panel>
      )}
    </>
  )
}
