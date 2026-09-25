import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { formatMoney } from '@/lib/monetisation/finance'
import { PageHeader, Panel, StatusPill } from '@/components/shell/page-header'
import { DataTable } from '@/components/ui/table'

export const dynamic = 'force-dynamic'

export default async function SponsorshipsPage() {
  const supabase = await createClient()
  const [{ data: deals }, { data: items }] = await Promise.all([
    supabase.from('brand_deals').select('*').in('status', ['contracted', 'in_production', 'delivered', 'invoiced', 'paid']).order('due_date'),
    supabase.from('content_items').select('id, title, status, brand_deal_id, platform').eq('is_sponsored', true),
  ])
  const rows = (deals ?? []).map(d => ({ ...d, content: (items ?? []).filter(i => i.brand_deal_id === d.id) }))
  return (
    <>
      <PageHeader title="Sponsorships" description="Active and completed deals with their sponsored content. Sponsored posts always carry #ad and need human approval." />
      <DataTable rows={rows} empty="No active sponsorships. Contract a deal in Brand Deals." columns={[
        { key: 't', label: 'Deal', render: d => d.title },
        { key: 'v', label: 'Value', render: d => formatMoney(d.value_cents, d.currency) },
        { key: 's', label: 'Status', render: d => <StatusPill tone={d.status === 'paid' ? 'ok' : 'info'}>{d.status.replace('_', ' ')}</StatusPill> },
        { key: 'd', label: 'Due', render: d => d.due_date ?? '—' },
        { key: 'c', label: 'Content', render: d => d.content.length ? <ul className="space-y-0.5 text-xs">{d.content.map(i => <li key={i.id}><Link href={`/content/items/${i.id}`} className="text-cyan-300 hover:underline">{i.title}</Link> <span className="text-slate-500">({i.status})</span></li>)}</ul> : <Link href="/content/generator" className="text-xs text-cyan-300 hover:underline">Create sponsored content</Link> },
      ]} />
      <Panel title="Deliverables" className="mt-4">
        <ul className="space-y-2 text-sm">{rows.map(d => <li key={d.id}><span className="font-medium">{d.title}:</span> <span className="text-slate-400">{(Array.isArray(d.deliverables) ? d.deliverables : []).join(' · ') || 'none listed'}</span></li>)}</ul>
      </Panel>
    </>
  )
}
