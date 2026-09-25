import { createClient } from '@/lib/supabase/server'
import { selectedCharacter } from '@/lib/data/characters'
import { PageHeader, Panel } from '@/components/shell/page-header'
import { CharacterFilter, NoCharacters } from '@/components/shell/character-filter'
import { ActionForm, Field, SubmitButton, Textarea } from '@/components/ui/form'
import { EmptyState, fmtDate } from '@/components/ui/table'
import { runTrendAnalysis } from '../actions'

export const dynamic = 'force-dynamic'

type Trend = { name: string; relevance: number; rationale: string }

export default async function TrendIntelligence({ searchParams }: { searchParams: Promise<{ character?: string }> }) {
  const { all, current } = await selectedCharacter((await searchParams).character)
  if (!current) return <><PageHeader title="Trend Intelligence" /><NoCharacters /></>
  const supabase = await createClient()
  const { data: tasks } = await supabase.from('agent_tasks').select('id, result, input, updated_at').eq('character_id', current.id).eq('type', 'trend_analysis').eq('status', 'completed').order('updated_at', { ascending: false }).limit(5)
  return (
    <>
      <PageHeader title="Trend Intelligence" description="Paste trend signals you have seen (topics, sounds, headlines). The Trend Research agent assesses them for this character — it does not scrape platforms." />
      <CharacterFilter path="/growth/trends" characters={all} current={current.id} />
      <Panel title="Analyse signals" className="mb-4">
        <ActionForm action={runTrendAnalysis}>
          <input type="hidden" name="characterId" value={current.id} />
          <Field label="Signals (one per line)"><Textarea name="signals" rows={5} /></Field>
          <SubmitButton>Analyse</SubmitButton>
        </ActionForm>
      </Panel>
      {(tasks ?? []).length === 0 ? <EmptyState>No analyses yet.</EmptyState> : tasks!.map(t => {
        const trends = ((t.result as { trends?: Trend[] } | null)?.trends ?? [])
        return (
          <Panel key={t.id} title={`Analysis · ${fmtDate(t.updated_at)}`} className="mb-3">
            <ul className="space-y-2 text-sm">{trends.map(tr => <li key={tr.name}><span className="font-medium text-slate-100">{tr.name}</span> <span className="text-xs text-slate-500">relevance {(tr.relevance * 100).toFixed(0)}%</span><p className="text-xs text-slate-400">{tr.rationale}</p></li>)}</ul>
            <p className="mt-2 text-xs text-slate-500">Resulting ideas were added to Content → Ideas.</p>
          </Panel>
        )
      })}
    </>
  )
}
