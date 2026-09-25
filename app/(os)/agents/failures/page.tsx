import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { requireWorkspace } from '@/lib/auth/session'
import { hasRole } from '@/lib/auth/roles'
import { PageHeader, Panel } from '@/components/shell/page-header'
import { ActionForm, SubmitButton } from '@/components/ui/form'
import { DataTable, fmtDate } from '@/components/ui/table'
import { cancelTask, requeueTask } from '../actions'

export const dynamic = 'force-dynamic'

export default async function FailuresPage() {
  const { role } = await requireWorkspace()
  const supabase = await createClient()
  const [{ data: tasks }, { data: runs }] = await Promise.all([
    supabase.from('agent_tasks').select('*').eq('status', 'failed').order('updated_at', { ascending: false }).limit(100),
    supabase.from('agent_runs').select('*').in('status', ['failed', 'budget_exceeded', 'policy_blocked']).order('started_at', { ascending: false }).limit(100),
  ])
  const canEdit = hasRole(role, 'editor')
  return (
    <>
      <PageHeader title="Failures" description="Failed tasks and blocked or failed runs, with the reason recorded." />
      <Panel title="Failed tasks" className="mb-4">
        <DataTable rows={tasks ?? []} empty="No failed tasks." columns={[
          { key: 'd', label: 'When', render: t => fmtDate(t.updated_at) },
          { key: 't', label: 'Task', render: t => `${t.title} (${t.type})` },
          { key: 'e', label: 'Error', render: t => <span className="text-xs text-red-300">{t.last_error}</span> },
          { key: 'a', label: '', render: t => canEdit && (
            <div className="flex gap-2">
              <ActionForm action={requeueTask}><input type="hidden" name="taskId" value={t.id} /><SubmitButton tone="ghost" className="px-2 py-1 text-xs">Re-queue</SubmitButton></ActionForm>
              <ActionForm action={cancelTask}><input type="hidden" name="taskId" value={t.id} /><SubmitButton tone="ghost" className="px-2 py-1 text-xs">Cancel</SubmitButton></ActionForm>
            </div>
          ) },
        ]} />
      </Panel>
      <Panel title="Unsuccessful runs">
        <DataTable rows={runs ?? []} empty="No unsuccessful runs." columns={[
          { key: 'd', label: 'When', render: r => <Link href={`/agents/runs/${r.id}`} className="text-cyan-300 hover:underline">{fmtDate(r.started_at)}</Link> },
          { key: 's', label: 'Status', render: r => r.status.replace('_', ' ') },
          { key: 'e', label: 'Reason', render: r => <span className="text-xs text-red-300">{r.error}</span> },
        ]} />
      </Panel>
    </>
  )
}
