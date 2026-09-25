import { createClient } from '@/lib/supabase/server'
import { selectedCharacter } from '@/lib/data/characters'
import { formatMoney, summarise } from '@/lib/monetisation/finance'
import { formatPct } from '@/lib/analytics/metrics'
import { PageHeader, Panel } from '@/components/shell/page-header'
import { CharacterFilter, NoCharacters } from '@/components/shell/character-filter'
import { ActionForm, SubmitButton } from '@/components/ui/form'
import { EmptyState, Stat, fmtDate } from '@/components/ui/table'
import { financeReport } from '../actions'

export const dynamic = 'force-dynamic'

export default async function RoiPage({ searchParams }: { searchParams: Promise<{ character?: string }> }) {
  const { all, current } = await selectedCharacter((await searchParams).character)
  if (!current) return <><PageHeader title="Profit / ROI" /><NoCharacters /></>
  const supabase = await createClient()
  const [{ data: rev }, { data: exp }, { data: reports }] = await Promise.all([
    supabase.from('revenue').select('amount_cents, currency, status, source_type, character_id').eq('character_id', current.id),
    supabase.from('expenses').select('amount_cents, currency, category, character_id').eq('character_id', current.id),
    supabase.from('agent_tasks').select('id, result, updated_at').eq('character_id', current.id).eq('type', 'finance_report').eq('status', 'completed').order('updated_at', { ascending: false }).limit(3),
  ])
  const s = summarise(rev ?? [], exp ?? [])
  return (
    <>
      <PageHeader title="Profit / ROI" description="All time, per currency (never converted). Profit = received revenue − expenses. Expected and pending income is shown separately." />
      <CharacterFilter path="/monetisation/roi" characters={all} current={current.id} />
      {s.length === 0 ? <EmptyState>No revenue or expenses recorded for {current.name}.</EmptyState> : s.map(c => (
        <div key={c.currency} className="mb-4">
          <h2 className="mb-2 text-sm font-medium text-slate-300">{c.currency}</h2>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Stat label="Received" value={formatMoney(c.receivedCents, c.currency)} />
            <Stat label="Pending / expected" value={formatMoney(c.pendingCents + c.expectedCents, c.currency)} />
            <Stat label="Expenses" value={formatMoney(c.expenseCents, c.currency)} />
            <Stat label="Profit" value={formatMoney(c.profitCents, c.currency)} />
            <Stat label="ROI" value={formatPct(c.roi)} hint={c.roi === null ? 'no expenses recorded' : undefined} />
          </div>
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <Panel title="Revenue by source"><ul className="space-y-1 text-sm">{Object.entries(c.bySource).map(([k, v]) => <li key={k} className="flex justify-between"><span>{k.replace('_', ' ')}</span><span>{formatMoney(v, c.currency)}</span></li>)}</ul></Panel>
            <Panel title="Expenses by category"><ul className="space-y-1 text-sm">{Object.entries(c.byExpenseCategory).map(([k, v]) => <li key={k} className="flex justify-between"><span>{k.replace('_', ' ')}</span><span>{formatMoney(v, c.currency)}</span></li>)}</ul></Panel>
          </div>
        </div>
      ))}
      <Panel title="Finance Analyst">
        <ActionForm action={financeReport}><input type="hidden" name="characterId" value={current.id} /><SubmitButton tone="ghost">Summarise the last 90 days</SubmitButton></ActionForm>
        {(reports ?? []).map(r => { const x = (r.result ?? {}) as { summary?: string; notes?: string[] }; return <div key={r.id} className="mt-3 text-sm"><p className="text-xs text-slate-500">{fmtDate(r.updated_at)}</p><p>{x.summary}</p><ul className="text-xs text-slate-400">{(x.notes ?? []).map(n => <li key={n}>• {n}</li>)}</ul></div> })}
      </Panel>
    </>
  )
}
