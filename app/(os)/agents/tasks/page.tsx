import { createClient } from '@/lib/supabase/server'
import { requireWorkspace } from '@/lib/auth/session'
import { hasRole } from '@/lib/auth/roles'
import { selectedCharacter } from '@/lib/data/characters'
import { AGENT_DEFINITIONS } from '@/lib/agents/definitions'
import { PageHeader, Panel, StatusPill } from '@/components/shell/page-header'
import { CharacterFilter, NoCharacters } from '@/components/shell/character-filter'
import { ActionForm, Checkbox, Field, Input, Select, SubmitButton, Textarea } from '@/components/ui/form'
import { DataTable, fmtDate } from '@/components/ui/table'
import { cancelTask, createTask, decideProposedTask } from '../actions'

export const dynamic = 'force-dynamic'

const TASK_OPTIONS = Object.values(AGENT_DEFINITIONS).flatMap(d => Object.entries(d.tasks).map(([t, def]) => ({ value: `${d.role}.${t}`, label: `${d.name} — ${def.description}` })))

export default async function TasksPage({ searchParams }: { searchParams: Promise<{ character?: string }> }) {
  const { role } = await requireWorkspace()
  const { all, current } = await selectedCharacter((await searchParams).character)
  if (!current) return <><PageHeader title="Agent Tasks" /><NoCharacters /></>
  const supabase = await createClient()
  const [{ data: tasks }, { data: agents }] = await Promise.all([
    supabase.from('agent_tasks').select('*').eq('character_id', current.id).order('created_at', { ascending: false }).limit(100),
    supabase.from('agents').select('id, role').eq('character_id', current.id),
  ])
  const roleOf = (id: string) => agents?.find(a => a.id === id)?.role ?? '—'
  const canEdit = hasRole(role, 'editor')
  const proposed = (tasks ?? []).filter(t => t.status === 'proposed')
  return (
    <>
      <PageHeader title="Agent Tasks" description="Queue work for an agent. Tasks proposed by the CEO agent wait for your decision." />
      <CharacterFilter path="/agents/tasks" characters={all} current={current.id} />
      {proposed.length > 0 && (
        <Panel title={`Proposed by agents (${proposed.length})`} className="mb-4">
          <DataTable rows={proposed} empty="" columns={[
            { key: 'r', label: 'Agent', render: t => roleOf(t.agent_id) },
            { key: 't', label: 'Task', render: t => <div><p>{t.title}</p><pre className="mt-1 max-h-24 overflow-auto text-[11px] text-slate-500">{JSON.stringify(t.input)}</pre></div> },
            { key: 'a', label: '', render: t => canEdit && (
              <div className="flex gap-2">
                <ActionForm action={decideProposedTask}><input type="hidden" name="taskId" value={t.id} /><input type="hidden" name="accept" value="true" /><SubmitButton className="px-2 py-1 text-xs">Queue</SubmitButton></ActionForm>
                <ActionForm action={decideProposedTask}><input type="hidden" name="taskId" value={t.id} /><input type="hidden" name="accept" value="false" /><SubmitButton tone="ghost" className="px-2 py-1 text-xs">Cancel</SubmitButton></ActionForm>
              </div>
            ) },
          ]} />
        </Panel>
      )}
      {canEdit && (
        <Panel title="New task" className="mb-4">
          <ActionForm action={createTask}>
            <input type="hidden" name="characterId" value={current.id} />
            <Field label="Task"><Select name="task" options={TASK_OPTIONS} /></Field>
            <Field label="Title (optional)"><Input name="title" maxLength={300} /></Field>
            <Field label="Input (JSON)" hint='Validated against the task schema, e.g. {"count":5} for Generate ideas, {"signals":["…"]} for Trend analysis.'><Textarea name="input" rows={4} defaultValue="{}" className="font-mono text-xs" /></Field>
            <Checkbox name="runNow" label="Run now" defaultChecked />
            <SubmitButton>Queue task</SubmitButton>
          </ActionForm>
        </Panel>
      )}
      <DataTable rows={tasks ?? []} empty="No tasks yet." columns={[
        { key: 'c', label: 'Created', render: t => fmtDate(t.created_at) },
        { key: 'r', label: 'Agent', render: t => roleOf(t.agent_id) },
        { key: 't', label: 'Task', render: t => <span>{t.title} <span className="text-xs text-slate-500">({t.type})</span></span> },
        { key: 's', label: 'Status', render: t => <StatusPill tone={t.status === 'completed' ? 'ok' : t.status === 'failed' ? 'warn' : 'info'}>{t.status}</StatusPill> },
        { key: 'a', label: 'Attempts', render: t => `${t.attempts}/${t.max_attempts}` },
        { key: 'e', label: 'Error', render: t => <span className="text-xs text-red-300">{t.last_error ?? ''}</span> },
        { key: 'x', label: '', render: t => canEdit && ['pending', 'queued'].includes(t.status) && <ActionForm action={cancelTask}><input type="hidden" name="taskId" value={t.id} /><SubmitButton tone="ghost" className="px-2 py-1 text-xs">Cancel</SubmitButton></ActionForm> },
      ]} />
    </>
  )
}
