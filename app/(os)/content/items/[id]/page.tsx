import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { requireWorkspace } from '@/lib/auth/session'
import { hasRole } from '@/lib/auth/roles'
import { aiProviderSummary } from '@/lib/ai/registry'
import { composeCaption } from '@/lib/publishing/attempt'
import { PageHeader, Panel, StatusPill } from '@/components/shell/page-header'
import { ActionForm, Field, Input, Select, SubmitButton, Textarea } from '@/components/ui/form'
import { DataTable, NotConfigured, fmtDate } from '@/components/ui/table'
import { ApprovalList } from '@/components/approvals/approval-list'
import { archiveItem, askAgent, clearFlag, generateImage, removeContentAsset, requestPublish, runSafety, saveItemVersion } from '../../actions'
import { MediaUploader } from './media-uploader'

export const dynamic = 'force-dynamic'

const EDITABLE = ['draft', 'in_review', 'rejected', 'failed']
const safetyTone = (s: string) => (s === 'passed' ? 'ok' : s === 'blocked' ? 'warn' : s === 'flagged' ? 'warn' : 'off') as 'ok' | 'warn' | 'off'

export default async function ContentItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound()
  const { role } = await requireWorkspace()
  const supabase = await createClient()
  const { data: item } = await supabase.from('content_items').select('*').eq('id', id).maybeSingle()
  if (!item) notFound()
  const { data: character } = await supabase.from('characters').select('name').eq('id', item.character_id).maybeSingle()
  const [{ data: versions }, { data: assets }, { data: accounts }, { data: approvals }, { data: jobs }, { data: metrics }] = await Promise.all([
    supabase.from('content_versions').select('*').eq('content_item_id', id).order('version', { ascending: false }),
    supabase.from('content_assets').select('*').eq('content_item_id', id).eq('status', 'ready').order('created_at'),
    supabase.from('social_accounts').select('id, handle, platform, status').eq('character_id', item.character_id).eq('platform', item.platform),
    supabase.from('agent_approvals').select('*').eq('entity_type', 'content_item').eq('entity_id', id).order('created_at', { ascending: false }),
    supabase.from('publishing_jobs').select('*').eq('content_item_id', id).order('created_at', { ascending: false }),
    supabase.from('content_metrics').select('*').eq('content_item_id', id).order('day', { ascending: false }).limit(1),
  ])
  const v = versions?.[0]
  const editable = EDITABLE.includes(item.status)
  const canEdit = hasRole(role, 'editor')
  const report = (item.safety_report ?? {}) as { rules?: { reasons?: string[]; moderation?: string }; agent?: { status?: string; reasons?: string[] }; humanReview?: { note?: string } }
  const ai = aiProviderSummary()
  const previews = await Promise.all((assets ?? []).map(async a => ({ ...a, url: (await supabase.storage.from(a.storage_bucket).createSignedUrl(a.storage_path, 300)).data?.signedUrl ?? null })))
  const connected = (accounts ?? []).filter(a => a.status === 'connected')
  const m = metrics?.[0]

  return (
    <>
      <PageHeader title={item.title} description={`${character?.name ?? ''} · ${item.platform} · ${item.format} · v${item.current_version}`}>
        <div className="flex flex-wrap gap-2">
          <StatusPill tone="info">{item.status}</StatusPill>
          <StatusPill tone={safetyTone(item.safety_status)}>safety: {item.safety_status}</StatusPill>
          <StatusPill tone={item.disclosure_applied ? 'ok' : 'off'}>{item.disclosure_applied ? 'disclosure applied' : 'disclosure pending'}</StatusPill>
          {item.is_sponsored && <StatusPill tone="warn">sponsored</StatusPill>}
        </div>
      </PageHeader>

      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
        <div className="space-y-4">
          <Panel title={editable ? 'Draft (saving creates a new version)' : 'Current version'}>
            {editable && canEdit ? (
              <ActionForm action={saveItemVersion}>
                <input type="hidden" name="itemId" value={id} />
                <Field label="Caption"><Textarea name="caption" rows={6} defaultValue={v?.caption ?? ''} maxLength={10000} /></Field>
                <Field label="Hashtags" hint="Space or comma separated"><Input name="hashtags" defaultValue={(v?.hashtags ?? []).map(h => `#${h}`).join(' ')} /></Field>
                <Field label="Script (video)"><Textarea name="script" rows={4} defaultValue={v?.script ?? ''} maxLength={20000} /></Field>
                <div className="grid gap-3 lg:grid-cols-2">
                  <Field label="Image prompt"><Textarea name="imagePrompt" rows={3} defaultValue={v?.image_prompt ?? ''} maxLength={4000} /></Field>
                  <Field label="Video prompt"><Textarea name="videoPrompt" rows={3} defaultValue={v?.video_prompt ?? ''} maxLength={4000} /></Field>
                </div>
                <SubmitButton>Save new version</SubmitButton>
              </ActionForm>
            ) : (
              <pre className="whitespace-pre-wrap text-sm text-slate-200">{v ? composeCaption(v) : 'No text yet.'}</pre>
            )}
          </Panel>

          <Panel title="Media">
            {previews.length === 0 ? <p className="mb-3 text-sm text-slate-500">No media attached.</p> : (
              <ul className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                {previews.map(a => (
                  <li key={a.id} className="rounded border border-slate-800 p-2 text-xs text-slate-400">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {a.url && a.kind === 'image' ? <img src={a.url} alt="" className="mb-1 aspect-square w-full rounded object-cover" /> : a.url && a.kind === 'video' ? <video src={a.url} controls className="mb-1 w-full rounded" /> : null}
                    <p>{a.provenance === 'ai_generated' ? `AI · ${a.generation_provider ?? ''}` : 'Uploaded'}</p>
                    {editable && canEdit && <ActionForm action={removeContentAsset}><input type="hidden" name="assetId" value={a.id} /><SubmitButton tone="ghost" className="mt-1 px-2 py-1 text-[11px]">Remove</SubmitButton></ActionForm>}
                  </li>
                ))}
              </ul>
            )}
            {editable && canEdit && (
              <div className="flex flex-wrap items-start gap-3">
                <MediaUploader itemId={id} />
                {ai.image ? (
                  <ActionForm action={generateImage}><input type="hidden" name="itemId" value={id} /><SubmitButton tone="ghost">Generate image from prompt</SubmitButton></ActionForm>
                ) : <p className="text-xs text-slate-500">Image generation not configured (OPENAI_API_KEY).</p>}
              </div>
            )}
          </Panel>

          <Panel title="Versions">
            <DataTable rows={versions ?? []} empty="No versions yet." columns={[
              { key: 'v', label: 'Version', render: x => `v${x.version}` },
              { key: 'b', label: 'By', render: x => x.created_by_type },
              { key: 'c', label: 'Caption', render: x => <span className="line-clamp-2">{x.caption ?? '—'}</span> },
              { key: 'd', label: 'Created', render: x => fmtDate(x.created_at) },
            ]} />
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel title="1 · Safety review">
            {report.rules?.reasons?.length ? <ul className="mb-2 space-y-1 text-xs text-amber-200">{report.rules.reasons.map(r => <li key={r}>• {r}</li>)}</ul> : null}
            {report.agent && <p className="mb-2 text-xs text-slate-400">Safety agent: {report.agent.status} {report.agent.reasons?.join(' ')}</p>}
            {report.humanReview && <p className="mb-2 text-xs text-emerald-300">Cleared by a human: {report.humanReview.note}</p>}
            {editable && canEdit ? (
              <ActionForm action={runSafety}><input type="hidden" name="itemId" value={id} /><SubmitButton>Run safety review</SubmitButton></ActionForm>
            ) : null}
            {!ai.moderation && <p className="mt-2 text-xs text-slate-500">No moderation provider configured — content will be flagged for your review.</p>}
            {item.safety_status === 'flagged' && canEdit && (
              <ActionForm action={clearFlag} className="mt-3">
                <input type="hidden" name="itemId" value={id} />
                <Field label="I reviewed this content and it is acceptable because…"><Textarea name="note" rows={2} required minLength={5} maxLength={1000} /></Field>
                <SubmitButton tone="ghost">Clear flag</SubmitButton>
              </ActionForm>
            )}
          </Panel>

          <Panel title="2 · Request publishing approval">
            {item.status !== 'in_review' || item.safety_status !== 'passed' ? (
              <p className="text-sm text-slate-500">Available once the safety review has passed (status in review, safety passed).</p>
            ) : connected.length === 0 ? (
              <NotConfigured what={`A connected ${item.platform} account`}>Connect one in Social Accounts.</NotConfigured>
            ) : canEdit ? (
              <ActionForm action={requestPublish}>
                <input type="hidden" name="itemId" value={id} />
                <Field label="Account"><Select name="socialAccountId" options={connected.map(a => ({ value: a.id, label: `@${a.handle ?? a.id.slice(0, 8)}` }))} /></Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Date"><Input type="date" name="date" required /></Field>
                  <Field label="Time"><Input type="time" name="time" required /></Field>
                </div>
                <Field label="Timezone" hint="IANA name, e.g. Europe/London, Asia/Dhaka"><Input name="timezone" defaultValue={item.timezone} required /></Field>
                <SubmitButton>Request approval</SubmitButton>
              </ActionForm>
            ) : null}
          </Panel>

          <Panel title="Approvals"><ApprovalList rows={approvals ?? []} canDecide={canEdit} /></Panel>

          <Panel title="Publishing">
            {(jobs ?? []).length === 0 ? <p className="text-sm text-slate-500">Not scheduled.</p> : (
              <ul className="space-y-2 text-xs">{jobs!.map(j => <li key={j.id} className="rounded border border-slate-800 p-2"><StatusPill tone={j.status === 'succeeded' ? 'ok' : j.status === 'failed' || j.status === 'blocked' ? 'warn' : 'info'}>{j.status}</StatusPill> <span className="text-slate-400">{fmtDate(j.scheduled_for)} · attempts {j.attempts}/{j.max_attempts}</span>{j.last_error && <p className="mt-1 text-red-300">{j.last_error}</p>}</li>)}</ul>
            )}
            {m && <p className="mt-2 text-xs text-slate-400">Latest metrics ({m.day}): views {m.views ?? '—'} · likes {m.likes ?? '—'} · comments {m.comments ?? '—'}</p>}
          </Panel>

          {editable && canEdit && (
            <Panel title="Ask an agent">
              <ActionForm action={askAgent}>
                <input type="hidden" name="itemId" value={id} />
                <Field label="Agent"><Select name="agent" options={[
                  { value: 'copywriter', label: 'Copywriter — draft caption' }, { value: 'image_prompt', label: 'Image Prompt — write image prompt' },
                  { value: 'video_script', label: 'Video Script — write script' }, { value: 'quality', label: 'Quality — review' },
                  { value: 'creative_director', label: 'Creative Director — review' }, { value: 'character', label: 'Character — consistency check' },
                  { value: 'safety', label: 'Safety — review (can only flag/block)' },
                ]} /></Field>
                <Field label="Brief (optional)"><Textarea name="brief" rows={2} maxLength={4000} /></Field>
                <SubmitButton tone="ghost">Run</SubmitButton>
              </ActionForm>
            </Panel>
          )}
          {canEdit && item.status !== 'archived' && EDITABLE.concat('published').includes(item.status) && (
            <ActionForm action={archiveItem}><input type="hidden" name="itemId" value={id} /><SubmitButton tone="ghost" className="text-xs">Archive</SubmitButton></ActionForm>
          )}
        </div>
      </div>
    </>
  )
}
