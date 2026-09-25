import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { requireWorkspace } from '@/lib/auth/session'
import { hasRole } from '@/lib/auth/roles'
import { PageHeader } from '@/components/shell/page-header'
import { ApprovalList } from '@/components/approvals/approval-list'

export const dynamic = 'force-dynamic'

const STATUSES = ['AWAITING_APPROVAL', 'APPROVED', 'EXECUTING', 'COMPLETED', 'REJECTED', 'FAILED', 'DRAFT'] as const

export default async function ApprovalRequests({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const s = (await searchParams).status
  const status = (STATUSES as readonly string[]).includes(s ?? '') ? (s as (typeof STATUSES)[number]) : 'AWAITING_APPROVAL'
  const { role } = await requireWorkspace()
  const supabase = await createClient()
  const { data } = await supabase.from('agent_approvals').select('*').eq('status', status).order('created_at', { ascending: false }).limit(100)
  return (
    <>
      <PageHeader title="Approval Requests" description="Every action that needs a human: publishing, replies, outreach, memory updates and delegated tasks." />
      <nav className="mb-4 flex flex-wrap gap-2 text-xs">
        {STATUSES.map(x => <Link key={x} href={`/agents/approvals?status=${x}`} className={`rounded-full border px-3 py-1 ${x === status ? 'border-cyan-600 text-cyan-200' : 'border-slate-700 text-slate-400'}`}>{x.replace('_', ' ').toLowerCase()}</Link>)}
      </nav>
      <ApprovalList rows={data ?? []} canDecide={hasRole(role, 'editor')} />
    </>
  )
}
