'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { confirmAssetUpload, prepareAssetUpload } from '../../actions'
import { Checkbox, Field, Input, Select } from '@/components/ui/form'

const KINDS = ['avatar', 'reference_image', 'style_guide', 'voice_sample', 'logo', 'consent_evidence', 'other'] as const

export function AssetUploader({ characterId }: { characterId: string }) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const fd = new FormData(form)
    const file = fd.get('file') as File | null
    if (!file || file.size === 0) return setMsg({ ok: false, text: 'Choose a file.' })
    const kind = fd.get('kind') as (typeof KINDS)[number]
    const bucket = kind === 'reference_image' ? 'reference-images' : 'character-assets'
    setBusy(true); setMsg(null)
    try {
      const prep = await prepareAssetUpload({ id: characterId, bucket, fileName: file.name, mimeType: file.type, bytes: file.size })
      if (!prep.ok) throw new Error(prep.message)
      const up = await createClient().storage.from(bucket).uploadToSignedUrl(prep.path, prep.token, file, { contentType: file.type })
      if (up.error) throw new Error(up.error.message)
      const res = await confirmAssetUpload({
        id: characterId, bucket, fileName: file.name, mimeType: file.type, bytes: file.size, path: prep.path, kind,
        provenance: fd.get('provenance') as 'owned' | 'licensed' | 'ai_generated', rightsNotes: String(fd.get('rightsNotes') ?? '') || undefined,
        depictsRealPerson: fd.get('depictsRealPerson') === 'on',
      })
      if (!res?.ok) throw new Error(res?.message ?? 'failed')
      setMsg({ ok: true, text: 'Uploaded.' })
      form.reset()
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message })
    } finally { setBusy(false) }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Type"><Select name="kind" options={KINDS.map(k => ({ value: k, label: k.replace('_', ' ') }))} /></Field>
        <Field label="Rights"><Select name="provenance" options={[{ value: 'owned', label: 'I own it' }, { value: 'licensed', label: 'Licensed' }, { value: 'ai_generated', label: 'AI generated' }]} /></Field>
        <Field label="File" hint="PNG, JPEG, WebP, GIF, MP3, WAV or PDF · max 20 MB"><Input type="file" name="file" accept="image/png,image/jpeg,image/webp,image/gif,audio/mpeg,audio/wav,application/pdf" /></Field>
      </div>
      <Field label="Rights notes"><Input name="rightsNotes" maxLength={1000} placeholder="Licence, source, photographer…" /></Field>
      <Checkbox name="depictsRealPerson" label="This file shows a real person (requires consent evidence on the character)" />
      <button type="submit" disabled={busy} className="rounded-md bg-cyan-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">{busy ? 'Uploading…' : 'Upload'}</button>
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'text-xs text-emerald-300' : 'text-xs text-red-300'}>{msg.text}</p>}
    </form>
  )
}
