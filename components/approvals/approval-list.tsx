import Link from 'next/link'
import type { AgentApprovalsRow } from '@/types/database'
import { StatusPill } from '@/components/shell/page-header'
import { ActionForm, Input, SubmitButton } from '@/components/ui/form'
import { EmptyState, fmtDate } from '@/components/ui/table'
import { decide, retry } from '@/app/(os)/agents/approval-actions'

const tone = (s: string) => (s === 'COMPLETED' || s === 'APPROVED' ? 'ok' : s === 'FAILED' || s === 'REJECTED' ? 'warn' : s === 'AWAITING_APPROVAL' ? 'info' : 'off') as 'ok' | 'warn' | 'info' | 'off'

function PayloadPreview({ a }: { a: AgentApprovalsRow }) {
  const p = (a.payload ?? {}) as Record<string, unknown>
  if (a.action_type === 'brand_outreach') {
    return <div className="mt-2 rounded border border-slate-800 bg-slate-950 p-2 text-xs"><p className="font-medium text-slate-200">{String(p.subject ?? '')}</p><p className="mt-1 whitespace-pre-wrap text-slate-400">{String(p.body ?? '')}</p></div>
  }
  return <pre className="mt-2 max-h-32 overflow-auto rounded border border-slate-800 bg-slate-950 p-2 text-[11px] text-slate-400">{JSON.stringify(p, null, 2)}</pre>
}

function ResultPreview({ a }: { a: AgentApprovalsRow }) {
  const r = (a.result ?? null) as Record<string, unknown> | null
  if (!r) return null
  if (r.delivery === 'manual') {
    return <div className="mt-2 rounded border border-amber-900/60 bg-amber-950/20 p-2 text-xs text-amber-200"><p>{String(r.note ?? '')}</p>{typeof r.text === 'string' && <pre className="mt-1 whitespace-pre-wrap text-amber-100/80">{r.text}</pre>}</div>
  }
  return <p className="mt-2 text-xs text-slate-400">Result: {Object.entries(r).map(([k, v]) => `${k}: ${String(v)}`).join(' · ')}</p>
}

/** Approval cards with approve/reject controls for pending items. */
export function ApprovalList({ rows, canDecide }: { rows: AgentApprovalsRow[]; canDecide: boolean }) {
  if (!rows.length) return <EmptyState>Nothing here.</EmptyState>
  return (
    <ul className="space-y-3">
      {rows.map(a => (
        <li key={a.id} className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-medium text-slate-100">{a.title}</p>
              <p className="mt-0.5 text-xs text-slate-400">
                {a.action_type.replaceAll('_', ' ')} · requested by {a.requested_by_type === 'agent' ? 'an agent' : a.requested_by_type} · {fmtDate(a.created_at)}
              </p>
              {a.summary && <p className="mt-1 text-sm text-slate-300">{a.summary}</p>}
            </div>
            <div className="flex gap-2">
              <StatusPill tone={a.risk_level === 'high' ? 'warn' : 'off'}>{a.risk_level} risk</StatusPill>
              <StatusPill tone={tone(a.status)}>{a.status}</StatusPill>
            </div>
          </div>
          {a.entity_type === 'content_item' && a.entity_id && <Link href={`/content/items/${a.entity_id}`} className="mt-2 inline-block text-xs text-cyan-300 hover:underline">Open the content →</Link>}
          <PayloadPreview a={a} />
          <ResultPreview a={a} />
          {a.error && <p className="mt-2 text-xs text-red-300">{a.error}</p>}
          {a.decision_note && <p className="mt-2 text-xs text-slate-400">Note: {a.decision_note}</p>}
          {canDecide && a.status === 'AWAITING_APPROVAL' && (
            <ActionForm action={decide} className="mt-3 space-y-2">
              <input type="hidden" name="approvalId" value={a.id} />
              <Input name="note" placeholder="Note (required to reject)" maxLength={2000} />
              <div className="flex gap-2">
                <button type="submit" name="decision" value="APPROVED" className="rounded-md bg-emerald-700 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-600">Approve</button>
                <button type="submit" name="decision" value="REJECTED" className="rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800">Reject</button>
              </div>
            </ActionForm>
          )}
          {canDecide && a.status === 'FAILED' && (
            <ActionForm action={retry} className="mt-3"><input type="hidden" name="approvalId" value={a.id} /><SubmitButton tone="ghost" className="text-xs">Send back for a fresh decision</SubmitButton></ActionForm>
          )}
        </li>
      ))}
    </ul>
  )
}
