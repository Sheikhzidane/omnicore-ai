import type { EngagementItemsRow } from '@/types/database'
import { StatusPill } from '@/components/shell/page-header'
import { ActionForm, Input, SubmitButton } from '@/components/ui/form'
import { EmptyState, fmtDate } from '@/components/ui/table'
import { setItemStatus, writeReply } from '@/app/(os)/engagement/actions'

export function InboxList({ items, canEdit }: { items: EngagementItemsRow[]; canEdit: boolean }) {
  if (!items.length) return <EmptyState>Nothing here. Comments and mentions arrive through verified platform webhooks.</EmptyState>
  return (
    <ul className="space-y-3">
      {items.map(i => (
        <li key={i.id} className="rounded-lg border border-slate-800 bg-slate-900/40 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
            <span>{i.platform} · {i.kind} · @{i.author_handle ?? 'unknown'} · {fmtDate(i.received_at)}</span>
            <span className="flex gap-1"><StatusPill tone="info">{i.status.replace('_', ' ')}</StatusPill>{i.moderation_status !== 'unchecked' && <StatusPill tone={i.moderation_status === 'ok' ? 'ok' : 'warn'}>{i.moderation_status}</StatusPill>}</span>
          </div>
          <p className="mt-1 text-sm text-slate-200">{i.body}</p>
          {canEdit && (
            <div className="mt-2 flex flex-col gap-2 lg:flex-row lg:items-start">
              <ActionForm action={writeReply} className="flex flex-1 gap-2 space-y-0">
                <input type="hidden" name="itemId" value={i.id} />
                <Input name="body" placeholder="Write a reply draft…" maxLength={2200} />
                <SubmitButton tone="ghost" className="shrink-0">Save draft</SubmitButton>
              </ActionForm>
              <div className="flex gap-1">
                {(['needs_reply', 'ignored', 'escalated', 'hidden'] as const).filter(s => s !== i.status).map(s => (
                  <ActionForm key={s} action={setItemStatus}><input type="hidden" name="itemId" value={i.id} /><input type="hidden" name="status" value={s} /><SubmitButton tone="ghost" className="px-2 py-1 text-[11px]">{s.replace('_', ' ')}</SubmitButton></ActionForm>
                ))}
              </div>
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}
