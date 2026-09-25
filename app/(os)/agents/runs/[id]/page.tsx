import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { PageHeader, Panel, StatusPill } from '@/components/shell/page-header'
import { fmtDate } from '@/components/ui/table'

export const dynamic = 'force-dynamic'

export default async function RunDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound()
  const supabase = await createClient()
  const { data: run } = await supabase.from('agent_runs').select('*').eq('id', id).maybeSingle()
  if (!run) notFound()
  const [{ data: events }, { data: task }] = await Promise.all([
    supabase.from('agent_run_events').select('*').eq('agent_run_id', id).order('seq'),
    supabase.from('agent_tasks').select('title, type, input').eq('id', run.agent_task_id).maybeSingle(),
  ])
  return (
    <>
      <PageHeader title={task?.title ?? 'Agent run'} description={`${task?.type ?? ''} · ${fmtDate(run.started_at)} · ${run.model ?? 'no model call'}`}>
        <StatusPill tone={run.status === 'succeeded' ? 'ok' : 'warn'}>{run.status}</StatusPill>
      </PageHeader>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Input"><pre className="max-h-80 overflow-auto text-xs text-slate-300">{JSON.stringify(task?.input ?? {}, null, 2)}</pre></Panel>
        <Panel title="Result"><pre className="max-h-80 overflow-auto text-xs text-slate-300">{JSON.stringify(run.output ?? run.error ?? null, null, 2)}</pre></Panel>
      </div>
      <Panel title="Events" className="mt-4">
        <ol className="space-y-2">
          {(events ?? []).map(e => (
            <li key={e.id} className="rounded border border-slate-800 p-2 text-xs">
              <span className="font-mono text-slate-500">#{e.seq}</span> <StatusPill tone={e.type === 'error' || e.type === 'policy_block' ? 'warn' : 'info'}>{e.type}</StatusPill>
              <pre className="mt-1 overflow-auto text-slate-400">{JSON.stringify(e.payload, null, 2)}</pre>
            </li>
          ))}
        </ol>
      </Panel>
    </>
  )
}
