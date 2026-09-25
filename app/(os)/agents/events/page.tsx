import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { PageHeader, StatusPill } from '@/components/shell/page-header'
import { DataTable, fmtDate } from '@/components/ui/table'

export const dynamic = 'force-dynamic'

export default async function EventLogs({ searchParams }: { searchParams: Promise<{ type?: string }> }) {
  const type = (await searchParams).type
  const supabase = await createClient()
  let q = supabase.from('agent_run_events').select('*').order('created_at', { ascending: false }).limit(200)
  if (type && ['message', 'tool_call', 'tool_result', 'decision', 'policy_block', 'error'].includes(type)) q = q.eq('type', type as 'error')
  const { data } = await q
  return (
    <>
      <PageHeader title="Event Logs" description="Step-by-step record of agent runs." />
      <nav className="mb-4 flex flex-wrap gap-2 text-xs">
        {['all', 'message', 'tool_result', 'decision', 'policy_block', 'error'].map(t => <Link key={t} href={t === 'all' ? '/agents/events' : `/agents/events?type=${t}`} className={`rounded-full border px-3 py-1 ${(type ?? 'all') === t ? 'border-cyan-600 text-cyan-200' : 'border-slate-700 text-slate-400'}`}>{t}</Link>)}
      </nav>
      <DataTable rows={data ?? []} empty="No events." columns={[
        { key: 'd', label: 'Time', render: e => fmtDate(e.created_at) },
        { key: 't', label: 'Type', render: e => <StatusPill tone={e.type === 'error' || e.type === 'policy_block' ? 'warn' : 'info'}>{e.type}</StatusPill> },
        { key: 'p', label: 'Details', render: e => <code className="line-clamp-2 break-all text-[11px] text-slate-400">{JSON.stringify(e.payload)}</code> },
        { key: 'r', label: 'Run', render: e => <Link href={`/agents/runs/${e.agent_run_id}`} className="text-cyan-300 hover:underline">open</Link> },
      ]} />
    </>
  )
}
