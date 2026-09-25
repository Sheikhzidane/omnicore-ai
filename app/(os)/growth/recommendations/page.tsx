import { createClient } from '@/lib/supabase/server'
import { selectedCharacter } from '@/lib/data/characters'
import { PageHeader, Panel, StatusPill } from '@/components/shell/page-header'
import { CharacterFilter, NoCharacters } from '@/components/shell/character-filter'
import { ActionForm, Field, Input, SubmitButton } from '@/components/ui/form'
import { EmptyState, fmtDate } from '@/components/ui/table'
import { runGrowthReport, runWeeklyStrategy } from '../actions'

export const dynamic = 'force-dynamic'

type Report = { summary?: string; insights?: string[]; recommendations?: { title: string; rationale: string; expectedImpact: string }[]; dataSufficient?: boolean; goals?: string[] }

export default async function Recommendations({ searchParams }: { searchParams: Promise<{ character?: string }> }) {
  const { all, current } = await selectedCharacter((await searchParams).character)
  if (!current) return <><PageHeader title="Recommendations" /><NoCharacters /></>
  const supabase = await createClient()
  const { data: tasks } = await supabase.from('agent_tasks').select('id, type, result, updated_at').eq('character_id', current.id).in('type', ['growth_report', 'weekly_strategy']).eq('status', 'completed').order('updated_at', { ascending: false }).limit(6)
  return (
    <>
      <PageHeader title="Recommendations" description="Growth Analyst and CEO agent output, based only on your stored metrics." />
      <CharacterFilter path="/growth/recommendations" characters={all} current={current.id} />
      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Panel title="Growth report">
          <ActionForm action={runGrowthReport}><input type="hidden" name="characterId" value={current.id} /><SubmitButton>Analyse the last 28 days</SubmitButton></ActionForm>
        </Panel>
        <Panel title="Weekly strategy (CEO agent)">
          <ActionForm action={runWeeklyStrategy}>
            <input type="hidden" name="characterId" value={current.id} />
            <Field label="Focus (optional)"><Input name="focus" maxLength={1000} /></Field>
            <SubmitButton>Plan the week</SubmitButton>
          </ActionForm>
        </Panel>
      </div>
      {(tasks ?? []).length === 0 ? <EmptyState>No reports yet.</EmptyState> : tasks!.map(t => {
        const r = (t.result ?? {}) as Report
        return (
          <Panel key={t.id} title={`${t.type === 'growth_report' ? 'Growth report' : 'Weekly strategy'} · ${fmtDate(t.updated_at)}`} className="mb-3">
            {r.dataSufficient === false && <p className="mb-2"><StatusPill tone="warn">Not enough data for firm conclusions</StatusPill></p>}
            {r.summary && <p className="text-sm text-slate-200">{r.summary}</p>}
            {r.goals?.length ? <ul className="mt-2 space-y-1 text-sm">{r.goals.map(g => <li key={g}>• {g}</li>)}</ul> : null}
            {r.insights?.length ? <ul className="mt-2 space-y-1 text-sm text-slate-300">{r.insights.map(i => <li key={i}>• {i}</li>)}</ul> : null}
            {r.recommendations?.length ? <ul className="mt-3 space-y-2">{r.recommendations.map(x => <li key={x.title} className="rounded border border-slate-800 p-2 text-sm"><span className="font-medium">{x.title}</span> <StatusPill tone="info">{x.expectedImpact} impact</StatusPill><p className="text-xs text-slate-400">{x.rationale}</p></li>)}</ul> : null}
          </Panel>
        )
      })}
    </>
  )
}
