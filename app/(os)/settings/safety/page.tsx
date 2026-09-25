import { createClient } from '@/lib/supabase/server'
import { agentsGloballyEnabled, FORBIDDEN_CAPABILITIES } from '@/lib/agents/permissions'
import { PROHIBITED_AUTOMATION } from '@/lib/safety/prohibited'
import { HARD_BLOCKED_CATEGORIES } from '@/lib/safety/policy'
import { getModerationProvider } from '@/lib/ai/registry'
import { PageHeader, Panel, StatusPill } from '@/components/shell/page-header'
import { DataTable } from '@/components/ui/table'

export const dynamic = 'force-dynamic'

export default async function SafetySettings() {
  const supabase = await createClient()
  const { data: chars } = await supabase.from('characters').select('id, name, ai_disclosure_mode, disclosure_text, approval_mode, age_restricted, min_audience_age, depicts_real_person, consent_evidence_path')
  const on = agentsGloballyEnabled(process.env)
  const moderation = getModerationProvider()
  return (
    <>
      <PageHeader title="Safety" description="Controls that apply to every character. Items marked fixed cannot be changed from the app." />
      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Panel title="Status">
          <ul className="space-y-2 text-sm">
            <li className="flex justify-between">Agent kill switch (AGENTS_ENABLED) <StatusPill tone={on ? 'warn' : 'ok'}>{on ? 'agents may run' : 'stopped'}</StatusPill></li>
            <li className="flex justify-between">Automated moderation <StatusPill tone={moderation ? 'ok' : 'warn'}>{moderation ? moderation.id : 'off — all content needs human review'}</StatusPill></li>
            <li className="flex justify-between">Human approval before any publish, reply or outreach <StatusPill tone="ok">fixed</StatusPill></li>
            <li className="flex justify-between">Sponsored-content disclosure <StatusPill tone="ok">fixed</StatusPill></li>
            <li className="flex justify-between">Content claiming the AI is human <StatusPill tone="ok">always blocked</StatusPill></li>
          </ul>
        </Panel>
        <Panel title="Never automated (fixed)">
          <ul className="space-y-1 text-xs text-slate-400">{Object.values(PROHIBITED_AUTOMATION).map(p => <li key={p}>• {p}</li>)}</ul>
        </Panel>
        <Panel title="Always-blocked content (fixed)">
          <ul className="space-y-1 text-xs text-slate-400">{HARD_BLOCKED_CATEGORIES.map(h => <li key={h}>• {h.replaceAll('_', ' ')}</li>)}</ul>
        </Panel>
        <Panel title="Agents can never (fixed)">
          <ul className="space-y-1 text-xs text-slate-400">{FORBIDDEN_CAPABILITIES.map(f => <li key={f}>• {f}</li>)}</ul>
        </Panel>
      </div>
      <Panel title="Per character (edit on each character's Profile)">
        <DataTable rows={chars ?? []} empty="No characters." columns={[
          { key: 'n', label: 'Character', render: c => c.name },
          { key: 'd', label: 'Disclosure', render: c => `${c.ai_disclosure_mode} · “${c.disclosure_text}”` },
          { key: 'a', label: 'Approval', render: c => c.approval_mode.replace('_', ' ') },
          { key: 'g', label: 'Audience', render: c => c.age_restricted ? `${c.min_audience_age}+ (restricted)` : `${c.min_audience_age}+` },
          { key: 'r', label: 'Real person', render: c => c.depicts_real_person ? <StatusPill tone={c.consent_evidence_path ? 'ok' : 'warn'}>{c.consent_evidence_path ? 'consent on file' : 'consent missing'}</StatusPill> : 'no' },
        ]} />
      </Panel>
    </>
  )
}
