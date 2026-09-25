import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { NAV } from '@/lib/nav'
import { PageHeader } from '@/components/shell/page-header'
import { Stat } from '@/components/ui/table'

export const dynamic = 'force-dynamic'

export default async function ContentStudio() {
  const supabase = await createClient()
  const { data } = await supabase.from('content_items').select('status')
  const by = (s: string[]) => (data ?? []).filter(d => s.includes(d.status)).length
  const sections = NAV.find(n => n.href === '/content')!.sections!
  return (
    <>
      <PageHeader title="Content Studio" description="Idea → draft → safety review → human approval → scheduled → published." />
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Drafts" value={by(['draft'])} />
        <Stat label="In review" value={by(['in_review'])} />
        <Stat label="Scheduled" value={by(['approved', 'scheduled', 'publishing'])} />
        <Stat label="Published" value={by(['published'])} />
        <Stat label="Failed" value={by(['failed'])} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {sections.map(s => <Link key={s.href} href={s.href} className="rounded-lg border border-slate-800 bg-slate-900/40 p-4 text-sm text-slate-100 hover:border-slate-600">{s.label}</Link>)}
      </div>
    </>
  )
}
