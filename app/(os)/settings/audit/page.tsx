import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { requireWorkspace } from '@/lib/auth/session'
import { PageHeader, StatusPill } from '@/components/shell/page-header'
import { DataTable, fmtDate } from '@/components/ui/table'

export const dynamic = 'force-dynamic'

export default async function AuditLogPage({ searchParams }: { searchParams: Promise<{ outcome?: string; page?: string }> }) {
  const sp = await searchParams
  const { workspace } = await requireWorkspace()
  const page = Math.max(0, Number(sp.page ?? 0) || 0)
  const supabase = await createClient()
  let q = supabase.from('audit_log').select('*').eq('workspace_id', workspace.id).order('created_at', { ascending: false }).range(page * 100, page * 100 + 99)
  if (sp.outcome && ['success', 'denied', 'error'].includes(sp.outcome)) q = q.eq('outcome', sp.outcome as 'success')
  const { data } = await q
  return (
    <>
      <PageHeader title="Audit Log" description="Append-only record of privileged actions in this workspace." />
      <nav className="mb-4 flex flex-wrap gap-2 text-xs">
        {['all', 'success', 'denied', 'error'].map(o => <Link key={o} href={o === 'all' ? '/settings/audit' : `/settings/audit?outcome=${o}`} className={`rounded-full border px-3 py-1 ${(sp.outcome ?? 'all') === o ? 'border-cyan-600 text-cyan-200' : 'border-slate-700 text-slate-400'}`}>{o}</Link>)}
      </nav>
      <DataTable rows={data ?? []} empty="No entries." columns={[
        { key: 'd', label: 'Time', render: a => fmtDate(a.created_at) },
        { key: 'a', label: 'Action', render: a => <span className="font-mono text-xs">{a.action}</span> },
        { key: 'w', label: 'Actor', render: a => `${a.actor_type}${a.actor_id ? ` ${a.actor_id.slice(0, 8)}` : ''}` },
        { key: 'e', label: 'Entity', render: a => a.entity_type ? `${a.entity_type} ${a.entity_id?.slice(0, 8) ?? ''}` : '—' },
        { key: 'o', label: 'Outcome', render: a => <StatusPill tone={a.outcome === 'success' ? 'ok' : 'warn'}>{a.outcome}</StatusPill> },
        { key: 'x', label: 'Details', render: a => <code className="line-clamp-2 break-all text-[11px] text-slate-500">{JSON.stringify(a.details)}</code> },
      ]} />
      <div className="mt-4 flex gap-2 text-sm">
        {page > 0 && <Link href={`/settings/audit?page=${page - 1}${sp.outcome ? `&outcome=${sp.outcome}` : ''}`} className="rounded border border-slate-700 px-3 py-1">Newer</Link>}
        {(data ?? []).length === 100 && <Link href={`/settings/audit?page=${page + 1}${sp.outcome ? `&outcome=${sp.outcome}` : ''}`} className="rounded border border-slate-700 px-3 py-1">Older</Link>}
      </div>
    </>
  )
}
