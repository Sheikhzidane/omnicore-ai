import { createClient } from '@/lib/supabase/server'
import { requireWorkspace } from '@/lib/auth/session'
import { hasRole } from '@/lib/auth/roles'
import { PageHeader, StatusPill } from '@/components/shell/page-header'
import { ActionForm, SubmitButton, Textarea } from '@/components/ui/form'
import { EmptyState, fmtDate } from '@/components/ui/table'
import { discardReply, requestSend } from '../actions'

export const dynamic = 'force-dynamic'

export default async function SuggestedReplies() {
  const { role } = await requireWorkspace()
  const supabase = await createClient()
  const { data: replies } = await supabase.from('engagement_replies').select('*').in('status', ['suggested', 'awaiting_approval', 'failed', 'sent']).order('created_at', { ascending: false }).limit(100)
  const ids = [...new Set((replies ?? []).map(r => r.engagement_item_id))]
  const { data: items } = ids.length ? await supabase.from('engagement_items').select('id, body, author_handle, platform').in('id', ids) : { data: [] }
  const canEdit = hasRole(role, 'editor')
  return (
    <>
      <PageHeader title="Suggested Replies" description="Drafts from you or the Community agent. Each send needs a human approval; the character's account is disclosed as AI." />
      {(replies ?? []).length === 0 ? <EmptyState>No drafts.</EmptyState> : (
        <ul className="space-y-3">
          {replies!.map(r => {
            const item = items?.find(i => i.id === r.engagement_item_id)
            return (
              <li key={r.id} className="rounded-lg border border-slate-800 bg-slate-900/40 p-3">
                <p className="text-xs text-slate-400">{item?.platform} · @{item?.author_handle ?? 'user'}: “{item?.body}”</p>
                <div className="mt-1 flex items-center gap-2 text-xs"><StatusPill tone={r.status === 'sent' ? 'ok' : r.status === 'failed' ? 'warn' : 'info'}>{r.status.replace('_', ' ')}</StatusPill>{r.is_ai_generated && <StatusPill tone="off">AI draft</StatusPill>}<span className="text-slate-500">{fmtDate(r.created_at)}</span></div>
                {r.error && <p className="mt-1 text-xs text-red-300">{r.error}</p>}
                {canEdit && ['suggested', 'failed'].includes(r.status) ? (
                  <ActionForm action={requestSend} className="mt-2">
                    <input type="hidden" name="replyId" value={r.id} />
                    <Textarea name="body" rows={2} defaultValue={r.body} maxLength={2200} />
                    <div className="flex gap-2"><SubmitButton>Request approval to send</SubmitButton></div>
                  </ActionForm>
                ) : <p className="mt-2 text-sm text-slate-200">{r.body}</p>}
                {canEdit && r.status === 'suggested' && <ActionForm action={discardReply} className="mt-1"><input type="hidden" name="replyId" value={r.id} /><SubmitButton tone="ghost" className="px-2 py-1 text-xs">Discard</SubmitButton></ActionForm>}
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}
