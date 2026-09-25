import { createClient } from '@/lib/supabase/server'
import { daysAgo, engagementRate, followerGrowth, formatCount, formatPct, latestPerDay, totals, type DailyRow } from '@/lib/analytics/metrics'
import { PageHeader } from '@/components/shell/page-header'
import { DataTable } from '@/components/ui/table'

export const dynamic = 'force-dynamic'

export default async function PlatformPerformance() {
  const supabase = await createClient()
  const since = daysAgo(28)
  const [{ data: daily }, { data: accounts }, { data: chars }] = await Promise.all([
    supabase.from('analytics_daily').select('*').gte('day', since),
    supabase.from('social_accounts').select('id, platform, handle, character_id, status'),
    supabase.from('characters').select('id, name'),
  ])
  const rows = (accounts ?? []).map(a => {
    const r = latestPerDay((daily ?? []).filter(d => d.social_account_id === a.id), () => a.id) as unknown as DailyRow[]
    const t = totals(r)
    return { id: a.id, a, t, rate: engagementRate(t), growth: followerGrowth(r), days: r.length }
  })
  return (
    <>
      <PageHeader title="Platform Performance" description="Per connected account, last 28 days." />
      <DataTable rows={rows} empty="No accounts." columns={[
        { key: 'c', label: 'Character', render: r => chars?.find(c => c.id === r.a.character_id)?.name ?? '—' },
        { key: 'p', label: 'Account', render: r => `${r.a.platform} @${r.a.handle ?? '—'}` },
        { key: 'd', label: 'Days of data', render: r => r.days },
        { key: 'r', label: 'Reach', render: r => formatCount(r.t.reach) },
        { key: 'v', label: 'Views', render: r => formatCount(r.t.views) },
        { key: 'i', label: 'Interactions', render: r => formatCount(r.t.interactions) },
        { key: 'e', label: 'Eng. rate', render: r => formatPct(r.rate) },
        { key: 'f', label: 'Followers Δ', render: r => r.growth ? r.growth.change : '—' },
      ]} />
    </>
  )
}
