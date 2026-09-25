import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { PageHeader, StatusPill } from '@/components/shell/page-header'
import { ActionForm, SubmitButton } from '@/components/ui/form'
import { DataTable, NotConfigured, fmtDate } from '@/components/ui/table'
import { cancelJob, retryJob } from '../actions'

export const dynamic = 'force-dynamic'

export default async function PublishingQueue() {
  const supabase = await createClient()
  const { data: jobs } = await supabase.from('publishing_jobs').select('*').in('status', ['pending', 'queued', 'running', 'failed', 'blocked']).order('scheduled_for')
  const ids = [...new Set((jobs ?? []).map(j => j.content_item_id))]
  const { data: items } = ids.length ? await supabase.from('content_items').select('id, title').in('id', ids) : { data: [] }
  const title = (id: string) => items?.find(i => i.id === id)?.title ?? id.slice(0, 8)
  return (
    <>
      <PageHeader title="Publishing Queue" description="Approved posts waiting for their time, running, or needing attention." />
      {!process.env.CRON_SECRET && <div className="mb-4"><NotConfigured what="The publishing scheduler" missing={['CRON_SECRET']}>Without it, Vercel Cron cannot call /api/cron/publish and nothing will be published.</NotConfigured></div>}
      <DataTable rows={jobs ?? []} empty="Nothing queued." columns={[
        { key: 't', label: 'Content', render: j => <Link href={`/content/items/${j.content_item_id}`} className="text-cyan-300 hover:underline">{title(j.content_item_id)}</Link> },
        { key: 'p', label: 'Platform', render: j => j.platform },
        { key: 'w', label: 'When', render: j => fmtDate(j.scheduled_for) },
        { key: 's', label: 'Status', render: j => <StatusPill tone={j.status === 'failed' || j.status === 'blocked' ? 'warn' : 'info'}>{j.status}</StatusPill> },
        { key: 'a', label: 'Attempts', render: j => `${j.attempts}/${j.max_attempts}${j.next_attempt_at ? ` · next ${fmtDate(j.next_attempt_at)}` : ''}` },
        { key: 'e', label: 'Last error', render: j => <span className="text-xs text-red-300">{j.last_error ?? ''}</span> },
        { key: 'x', label: '', render: j => ['pending', 'queued'].includes(j.status)
          ? <ActionForm action={cancelJob}><input type="hidden" name="jobId" value={j.id} /><SubmitButton tone="ghost" className="px-2 py-1 text-xs">Cancel</SubmitButton></ActionForm>
          : ['failed', 'blocked'].includes(j.status) ? <ActionForm action={retryJob}><input type="hidden" name="jobId" value={j.id} /><SubmitButton tone="ghost" className="px-2 py-1 text-xs">Fix & re-request</SubmitButton></ActionForm> : null },
      ]} />
    </>
  )
}
