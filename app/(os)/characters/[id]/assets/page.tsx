import { createClient } from '@/lib/supabase/server'
import { Panel, StatusPill } from '@/components/shell/page-header'
import { ActionForm, SubmitButton } from '@/components/ui/form'
import { DataTable, fmtDate } from '@/components/ui/table'
import { deleteAsset } from '../../actions'
import { AssetUploader } from './uploader'

export default async function AssetsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data } = await supabase.from('character_assets').select('*').eq('character_id', id).eq('status', 'ready').order('created_at', { ascending: false })
  // Private buckets: previews use short-lived signed URLs (members can read their workspace folder).
  const rows = await Promise.all((data ?? []).map(async a => ({
    ...a,
    preview: a.mime_type.startsWith('image/') ? (await supabase.storage.from(a.storage_bucket).createSignedUrl(a.storage_path, 300)).data?.signedUrl ?? null : null,
  })))
  return (
    <div className="space-y-4">
      <Panel title="Upload"><AssetUploader characterId={id} /></Panel>
      <DataTable rows={rows} empty="No assets yet." columns={[
        // eslint-disable-next-line @next/next/no-img-element
        { key: 'p', label: 'Preview', render: a => a.preview ? <img src={a.preview} alt={a.file_name} className="h-12 w-12 rounded object-cover" /> : <span className="text-xs text-slate-500">{a.mime_type}</span> },
        { key: 'n', label: 'File', render: a => <span className="break-all">{a.file_name}</span> },
        { key: 'k', label: 'Type', render: a => a.kind.replace('_', ' ') },
        { key: 'r', label: 'Rights', render: a => <StatusPill tone={a.provenance === 'owned' ? 'ok' : 'info'}>{a.provenance}</StatusPill> },
        { key: 's', label: 'Size', render: a => `${(a.bytes / 1024 / 1024).toFixed(2)} MB` },
        { key: 'd', label: 'Uploaded', render: a => fmtDate(a.created_at) },
        { key: 'x', label: '', render: a => <ActionForm action={deleteAsset}><input type="hidden" name="assetId" value={a.id} /><SubmitButton tone="ghost" className="px-2 py-1 text-xs">Delete</SubmitButton></ActionForm> },
      ]} />
    </div>
  )
}
