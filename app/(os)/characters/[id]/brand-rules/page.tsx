import { createClient } from '@/lib/supabase/server'
import { Panel, StatusPill } from '@/components/shell/page-header'
import { ActionForm, Field, Input, Select, SubmitButton } from '@/components/ui/form'
import { DataTable } from '@/components/ui/table'
import { addBrandRule, toggleBrandRule } from '../../actions'

const TYPES = ['do', 'dont', 'voice', 'topic_allowed', 'topic_blocked', 'hashtag', 'cta', 'brand_safety']

export default async function BrandRulesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data } = await supabase.from('character_brand_rules').select('*').eq('character_id', id).order('priority', { ascending: false })
  return (
    <div className="space-y-4">
      <Panel title="Add rule">
        <ActionForm action={addBrandRule} className="grid gap-3 sm:grid-cols-[170px_1fr_100px_auto] sm:items-end sm:space-y-0">
          <input type="hidden" name="id" value={id} />
          <Field label="Type"><Select name="ruleType" options={TYPES.map(t => ({ value: t, label: t }))} /></Field>
          <Field label="Rule"><Input name="rule" required maxLength={500} /></Field>
          <Field label="Priority"><Input name="priority" type="number" min={1} max={5} defaultValue={3} /></Field>
          <SubmitButton>Add</SubmitButton>
        </ActionForm>
        <p className="mt-2 text-xs text-slate-500"><code>topic_blocked</code> rules are enforced by the safety review; all active rules are given to every agent.</p>
      </Panel>
      <DataTable rows={data ?? []} empty="No brand rules yet." columns={[
        { key: 'type', label: 'Type', render: r => <span className="font-mono text-xs">{r.rule_type}</span> },
        { key: 'rule', label: 'Rule', render: r => r.rule },
        { key: 'pri', label: 'Priority', render: r => r.priority },
        { key: 'active', label: 'Status', render: r => <StatusPill tone={r.active ? 'ok' : 'off'}>{r.active ? 'active' : 'off'}</StatusPill> },
        { key: 'act', label: '', render: r => (
          <ActionForm action={toggleBrandRule}>
            <input type="hidden" name="ruleId" value={r.id} /><input type="hidden" name="active" value={String(!r.active)} />
            <SubmitButton tone="ghost" className="px-2 py-1 text-xs">{r.active ? 'Disable' : 'Enable'}</SubmitButton>
          </ActionForm>
        ) },
      ]} />
    </div>
  )
}
