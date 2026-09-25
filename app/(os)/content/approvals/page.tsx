import { createClient } from '@/lib/supabase/server'
import { requireWorkspace } from '@/lib/auth/session'
import { hasRole } from '@/lib/auth/roles'
import { PageHeader } from '@/components/shell/page-header'
import { ApprovalList } from '@/components/approvals/approval-list'

export const dynamic = 'force-dynamic'

export default async function ContentApprovalQueue() {
  const { role } = await requireWorkspace()
  const supabase = await createClient()
  const { data } = await supabase.from('agent_approvals').select('*').eq('action_type', 'publish_content').eq('status', 'AWAITING_APPROVAL').order('created_at')
  return (
    <>
      <PageHeader title="Approval Queue" description="Posts waiting for a human decision. Approving queues the post for its scheduled time; it is re-checked again at publish time." />
      <ApprovalList rows={data ?? []} canDecide={hasRole(role, 'editor')} />
    </>
  )
}
