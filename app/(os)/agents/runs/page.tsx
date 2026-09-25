import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { PageHeader, StatusPill } from '@/components/shell/page-header'
import { DataTable, fmtDate } from '@/components/ui/table'

export const dynamic = 'force-dynamic'

export default async function RunsPage() {
  const supabase = await createClient()
  const [{ data: runs }, { data: agents }] = await Promise.all([
    supabase.from('agent_runs').select('*').order('started_at', { ascending: false }).limit(100),
    supabase.from('agents').select('id, name'),
  ])
  return (
    <>
      <PageHeader title="Agent Runs" description="Every model call: status, tokens and cost as reported by the provider." />
      <DataTable rows={runs ?? []} empty="No runs yet." columns={[
        { key: 's', label: 'Started', render: r => <Link href={`/agents/runs/${r.id}`} className="text-cyan-300 hover:underline">{fmtDate(r.started_at)}</Link> },
        { key: 'a', label: 'Agent', render: r => agents?.find(a => a.id === r.agent_id)?.name ?? '—' },
        { key: 'st', label: 'Status', render: r => <StatusPill tone={r.status === 'succeeded' ? 'ok' : r.status === 'running' ? 'info' : 'warn'}>{r.status}</StatusPill> },
        { key: 'm', label: 'Model', render: r => <span className="text-xs">{r.model ?? '—'}</span> },
        { key: 't', label: 'Tokens in/out', render: r => `${r.input_tokens} / ${r.output_tokens}` },
        { key: 'c', label: 'Cost', render: r => `$${Number(r.cost_usd).toFixed(4)}` },
        { key: 'e', label: 'Error', render: r => <span className="line-clamp-2 text-xs text-red-300">{r.error ?? ''}</span> },
      ]} />
    </>
  )
}
