import { createClient } from '@/lib/supabase/server'
import { Panel, StatusPill } from '@/components/shell/page-header'
import { ActionForm, Field, Input, Select, SubmitButton, Textarea } from '@/components/ui/form'
import { DataTable } from '@/components/ui/table'
import { addMemory, confirmMemory } from '../../actions'

export default async function MemoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data } = await supabase.from('character_memories').select('*').eq('character_id', id).order('is_canon').order('importance', { ascending: false })
  const proposed = (data ?? []).filter(m => !m.is_canon), canon = (data ?? []).filter(m => m.is_canon)
  return (
    <div className="space-y-4">
      <Panel title="Add canon memory">
        <ActionForm action={addMemory}>
          <input type="hidden" name="id" value={id} />
          <div className="grid gap-3 sm:grid-cols-[180px_100px]">
            <Field label="Kind"><Select name="kind" options={['fact', 'preference', 'event', 'relationship', 'catchphrase', 'continuity'].map(k => ({ value: k, label: k }))} /></Field>
            <Field label="Importance"><Input type="number" name="importance" min={1} max={5} defaultValue={3} /></Field>
          </div>
          <Field label="Memory"><Textarea name="content" rows={2} required maxLength={2000} /></Field>
          <SubmitButton>Add memory</SubmitButton>
        </ActionForm>
      </Panel>
      <Panel title={`Proposed by agents (${proposed.length}) — not used until you confirm`}>
        <DataTable rows={proposed} empty="No proposals." columns={[
          { key: 'k', label: 'Kind', render: m => m.kind },
          { key: 'c', label: 'Memory', render: m => m.content },
          { key: 'a', label: '', render: m => (
            <div className="flex gap-2">
              <ActionForm action={confirmMemory}><input type="hidden" name="memoryId" value={m.id} /><input type="hidden" name="accept" value="true" /><SubmitButton className="px-2 py-1 text-xs">Confirm</SubmitButton></ActionForm>
              <ActionForm action={confirmMemory}><input type="hidden" name="memoryId" value={m.id} /><input type="hidden" name="accept" value="false" /><SubmitButton tone="ghost" className="px-2 py-1 text-xs">Discard</SubmitButton></ActionForm>
            </div>
          ) },
        ]} />
      </Panel>
      <Panel title={`Canon (${canon.length})`}>
        <DataTable rows={canon} empty="No canon memories yet." columns={[
          { key: 'k', label: 'Kind', render: m => m.kind },
          { key: 'c', label: 'Memory', render: m => m.content },
          { key: 'i', label: 'Importance', render: m => m.importance },
          { key: 's', label: 'Source', render: m => <StatusPill tone="info">{m.source}</StatusPill> },
        ]} />
      </Panel>
    </div>
  )
}
