import { createClient } from '@/lib/supabase/server'
import { requireWorkspace } from '@/lib/auth/session'
import { hasRole } from '@/lib/auth/roles'
import { selectedCharacter } from '@/lib/data/characters'
import { AGENT_DEFINITIONS } from '@/lib/agents/definitions'
import { ROLE_CAPABILITIES, agentsGloballyEnabled } from '@/lib/agents/permissions'
import { aiProviderSummary } from '@/lib/ai/registry'
import { PageHeader, Panel, StatusPill } from '@/components/shell/page-header'
import { CharacterFilter, NoCharacters } from '@/components/shell/character-filter'
import { ActionForm, Input, Select, SubmitButton } from '@/components/ui/form'
import { NotConfigured, Stat } from '@/components/ui/table'
import { bulkAgents, ensureRoster, updateAgent } from './actions'

export const dynamic = 'force-dynamic'

export default async function ControlCentre({ searchParams }: { searchParams: Promise<{ character?: string }> }) {
  const { role } = await requireWorkspace()
  const { all, current } = await selectedCharacter((await searchParams).character)
  if (!current) return <><PageHeader title="AI Agents" /><NoCharacters /></>
  const supabase = await createClient()
  const since = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').toISOString()
  const [{ data: agents }, { data: runs }, { count: pending }] = await Promise.all([
    supabase.from('agents').select('*').eq('character_id', current.id).order('role'),
    supabase.from('agent_runs').select('agent_id, cost_usd, status').eq('character_id', current.id).gte('started_at', since),
    supabase.from('agent_approvals').select('id', { count: 'exact', head: true }).eq('status', 'AWAITING_APPROVAL'),
  ])
  const on = agentsGloballyEnabled(process.env)
  const ai = aiProviderSummary()
  const admin = hasRole(role, 'admin')
  const spend = (runs ?? []).reduce((s, r) => s + Number(r.cost_usd), 0)
  return (
    <>
      <PageHeader title="AI Agents · Control Centre" description="15 agents per character. They have no tools: they draft, analyse and propose. Anything with real-world effect needs your approval." />
      <CharacterFilter path="/agents" characters={all} current={current.id} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Kill switch (AGENTS_ENABLED)" value={<StatusPill tone={on ? 'warn' : 'off'}>{on ? 'agents may run' : 'all agents stopped'}</StatusPill>} />
        <Stat label="Active agents" value={`${(agents ?? []).filter(a => a.status === 'active').length} / ${(agents ?? []).length}`} />
        <Stat label="Runs today" value={(runs ?? []).length} />
        <Stat label="AI spend today" value={`$${spend.toFixed(4)}`} hint={`${pending ?? 0} approvals waiting`} />
      </div>
      {!ai.text && <div className="mb-4"><NotConfigured what="A text AI provider" missing={['ANTHROPIC_API_KEY or OPENAI_API_KEY']} /></div>}
      {admin && (
        <div className="mb-4 flex flex-wrap gap-2">
          {(['active', 'paused', 'disabled'] as const).map(s => (
            <ActionForm key={s} action={bulkAgents}><input type="hidden" name="characterId" value={current.id} /><input type="hidden" name="status" value={s} /><SubmitButton tone="ghost" className="text-xs">Set all {s}</SubmitButton></ActionForm>
          ))}
          {(agents ?? []).length < 15 && <ActionForm action={ensureRoster}><input type="hidden" name="characterId" value={current.id} /><SubmitButton className="text-xs">Create missing agents</SubmitButton></ActionForm>}
        </div>
      )}
      <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
        {(agents ?? []).map(a => {
          const def = AGENT_DEFINITIONS[a.role]
          const todays = (runs ?? []).filter(r => r.agent_id === a.id)
          return (
            <Panel key={a.id}>
              <div className="flex items-start justify-between gap-2">
                <div><p className="font-medium text-slate-100">{def.name}</p><p className="text-xs text-slate-500">{Object.keys(def.tasks).join(', ')}</p></div>
                <StatusPill tone={a.status === 'active' ? 'ok' : a.status === 'paused' ? 'warn' : 'off'}>{a.status}</StatusPill>
              </div>
              <ul className="mt-2 space-y-0.5 text-xs text-slate-400">{def.responsibilities.map(r => <li key={r}>• {r}</li>)}</ul>
              <p className="mt-2 text-[11px] text-slate-500">Capabilities: {ROLE_CAPABILITIES[a.role].join(', ')}</p>
              <p className="mt-1 text-[11px] text-slate-500">Today: {todays.length} runs · ${todays.reduce((s, r) => s + Number(r.cost_usd), 0).toFixed(4)} of ${Number(a.daily_budget_usd).toFixed(2)}</p>
              {admin && (
                <ActionForm action={updateAgent} className="mt-3 grid grid-cols-2 gap-2 space-y-0">
                  <input type="hidden" name="agentId" value={a.id} />
                  <Select name="status" defaultValue={a.status} aria-label="Status" options={['disabled', 'active', 'paused'].map(s => ({ value: s, label: s }))} />
                  <Select name="autonomy" defaultValue={a.autonomy} aria-label="Autonomy" options={[{ value: 'suggest_only', label: 'suggest only' }, { value: 'approval_required', label: 'approval required' }, { value: 'autonomous_within_limits', label: 'within limits' }]} />
                  <Input name="dailyBudgetUsd" type="number" step="0.01" min={0} max={100} defaultValue={Number(a.daily_budget_usd)} aria-label="Daily budget (USD)" />
                  <Input name="maxActionsPerDay" type="number" min={0} max={500} defaultValue={a.max_actions_per_day} aria-label="Max runs per day" />
                  <SubmitButton tone="ghost" className="col-span-2 text-xs">Save</SubmitButton>
                </ActionForm>
              )}
            </Panel>
          )
        })}
      </div>
    </>
  )
}
