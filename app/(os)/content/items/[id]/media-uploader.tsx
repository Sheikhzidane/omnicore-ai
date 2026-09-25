'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { confirmContentUpload, prepareContentUpload } from '../../actions'

export function MediaUploader({ itemId }: { itemId: string }) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  async function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setBusy(true); setMsg(null)
    try {
      const prep = await prepareContentUpload({ itemId, fileName: file.name, mimeType: file.type, bytes: file.size })
      if (!prep.ok) throw new Error(prep.message)
      const up = await createClient().storage.from('generated-content').uploadToSignedUrl(prep.path, prep.token, file, { contentType: file.type })
      if (up.error) throw new Error(up.error.message)
      const r = await confirmContentUpload({ itemId, path: prep.path, mimeType: file.type, bytes: file.size })
      if (!r?.ok) throw new Error(r?.message ?? 'failed')
      setMsg({ ok: true, text: 'Attached.' })
    } catch (err) { setMsg({ ok: false, text: (err as Error).message }) } finally { setBusy(false); e.target.value = '' }
  }
  return (
    <div className="space-y-1">
      <label className="inline-block cursor-pointer rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800">
        {busy ? 'Uploading…' : 'Upload image or video'}
        <input type="file" className="sr-only" accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime,video/webm" onChange={onChange} disabled={busy} />
      </label>
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'text-xs text-emerald-300' : 'text-xs text-red-300'}>{msg.text}</p>}
    </div>
  )
}
