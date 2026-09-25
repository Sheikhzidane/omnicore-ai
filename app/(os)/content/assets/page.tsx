import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { PageHeader, StatusPill } from '@/components/shell/page-header'
import { EmptyState, fmtDate } from '@/components/ui/table'

export const dynamic = 'force-dynamic'

export default async function GeneratedAssetsPage() {
  const supabase = await createClient()
  const { data } = await supabase.from('content_assets').select('*').eq('status', 'ready').order('created_at', { ascending: false }).limit(60)
  const rows = await Promise.all((data ?? []).map(async a => ({ ...a, url: (await supabase.storage.from(a.storage_bucket).createSignedUrl(a.storage_path, 300)).data?.signedUrl ?? null })))
  return (
    <>
      <PageHeader title="Generated Assets" description="Images and videos attached to content. Private storage; previews use 5-minute signed links." />
      {rows.length === 0 ? <EmptyState>No media yet. Generate or upload media from a content item.</EmptyState> : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {rows.map(a => (
            <li key={a.id} className="rounded-lg border border-slate-800 bg-slate-900/40 p-2 text-xs text-slate-400">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {a.url && a.kind === 'image' ? <img src={a.url} alt="" className="mb-2 aspect-square w-full rounded object-cover" /> : a.url && a.kind === 'video' ? <video src={a.url} className="mb-2 aspect-square w-full rounded object-cover" controls /> : <div className="mb-2 aspect-square rounded bg-slate-900" />}
              <StatusPill tone={a.provenance === 'ai_generated' ? 'info' : 'off'}>{a.provenance === 'ai_generated' ? 'AI generated' : 'uploaded'}</StatusPill>
              <p className="mt-1">{fmtDate(a.created_at)}</p>
              {a.content_item_id && <Link href={`/content/items/${a.content_item_id}`} className="text-cyan-300 hover:underline">Open content</Link>}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
