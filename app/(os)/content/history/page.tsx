import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { PageHeader, StatusPill } from '@/components/shell/page-header'
import { DataTable, fmtDate } from '@/components/ui/table'

export const dynamic = 'force-dynamic'

const STATUSES = ['all', 'draft', 'in_review', 'scheduled', 'published', 'failed', 'rejected', 'archived']

export default async function HistoryPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const status = (await searchParams).status ?? 'all'
  const supabase = await createClient()
  let q = supabase.from('content_items').select('id, title, platform, format, status, safety_status, published_at, updated_at, character_id').order('updated_at', { ascending: false }).limit(200)
  if (status !== 'all' && STATUSES.includes(status)) q = q.eq('status', status as 'draft')
  const [{ data }, { data: results }] = await Promise.all([q, supabase.from('publishing_results').select('publishing_job_id, url, status').eq('status', 'success')])
  const { data: jobs } = await supabase.from('publishing_jobs').select('id, content_item_id').eq('status', 'succeeded')
  const urlFor = (itemId: string) => { const j = jobs?.find(x => x.content_item_id === itemId); return j ? results?.find(r => r.publishing_job_id === j.id)?.url ?? null : null }
  return (
    <>
      <PageHeader title="History" description="All content, newest first." />
      <nav className="mb-4 flex flex-wrap gap-2 text-xs">
        {STATUSES.map(s => <Link key={s} href={`/content/history?status=${s}`} className={`rounded-full border px-3 py-1 ${s === status ? 'border-cyan-600 text-cyan-200' : 'border-slate-700 text-slate-400'}`}>{s.replace('_', ' ')}</Link>)}
      </nav>
      <DataTable rows={data ?? []} empty="No content." columns={[
        { key: 't', label: 'Title', render: i => <Link href={`/content/items/${i.id}`} className="text-cyan-300 hover:underline">{i.title}</Link> },
        { key: 'p', label: 'Platform', render: i => `${i.platform} · ${i.format}` },
        { key: 's', label: 'Status', render: i => <StatusPill tone={i.status === 'published' ? 'ok' : i.status === 'failed' ? 'warn' : 'off'}>{i.status}</StatusPill> },
        { key: 'sa', label: 'Safety', render: i => i.safety_status },
        { key: 'u', label: 'Published', render: i => { const u = urlFor(i.id); return i.published_at ? (u ? <a href={u} target="_blank" rel="noreferrer" className="text-cyan-300 hover:underline">{fmtDate(i.published_at)}</a> : fmtDate(i.published_at)) : '—' } },
        { key: 'd', label: 'Updated', render: i => fmtDate(i.updated_at) },
      ]} />
    </>
  )
}
