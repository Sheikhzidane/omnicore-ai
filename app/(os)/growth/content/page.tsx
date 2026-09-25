import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { formatCount, formatPct, latestPerDay, rankContent, type DailyRow } from '@/lib/analytics/metrics'
import { PageHeader } from '@/components/shell/page-header'
import { DataTable } from '@/components/ui/table'

export const dynamic = 'force-dynamic'

export default async function ContentPerformance() {
  const supabase = await createClient()
  const [{ data: metrics }, { data: items }] = await Promise.all([
    supabase.from('content_metrics').select('*').order('day'),
    supabase.from('content_items').select('id, title, platform').eq('status', 'published'),
  ])
  // Metrics are cumulative per snapshot, so use each post's latest snapshot.
  const ranked = rankContent((items ?? []).map(i => {
    const snaps = latestPerDay((metrics ?? []).filter(m => m.content_item_id === i.id), () => i.id)
    const last = snaps[snaps.length - 1]
    return { id: i.id, title: i.title, platform: i.platform, rows: last ? [{ ...last, followers: null } as unknown as DailyRow] : [] }
  })).map(r => ({ ...r, id: r.contentItemId }))
  return (
    <>
      <PageHeader title="Content Performance" description="Latest platform-reported numbers per published post. Posts without synced metrics are not listed." />
      <DataTable rows={ranked} empty="No published posts with metrics yet. Metrics sync daily via /api/cron/metrics." columns={[
        { key: 't', label: 'Post', render: r => <Link href={`/content/items/${r.id}`} className="text-cyan-300 hover:underline">{r.title}</Link> },
        { key: 'p', label: 'Platform', render: r => r.platform },
        { key: 'v', label: 'Views', render: r => formatCount(r.views) },
        { key: 'i', label: 'Interactions', render: r => formatCount(r.interactions) },
        { key: 'e', label: 'Eng. rate', render: r => formatPct(r.rate) },
      ]} />
    </>
  )
}
