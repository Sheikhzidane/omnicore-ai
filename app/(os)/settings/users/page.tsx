import { requireWorkspace } from '@/lib/auth/session'
import { hasRole } from '@/lib/auth/roles'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { parseEmailList } from '@/lib/auth/routes'
import { PageHeader, Panel, StatusPill } from '@/components/shell/page-header'
import { ActionForm, Field, Input, Select, SubmitButton } from '@/components/ui/form'
import { DataTable, fmtDate } from '@/components/ui/table'
import { addMember, changeMember } from '../actions'

export const dynamic = 'force-dynamic'

export default async function UsersPage() {
  const { role, user, workspace } = await requireWorkspace()
  const supabase = await createClient()
  const { data: members } = await supabase.from('workspace_members').select('*').eq('workspace_id', workspace.id).order('created_at')
  const owner = hasRole(role, 'owner')
  // Emails are shown to the owner only (read server-side with the admin API).
  const emails = new Map<string, string>()
  if (owner) {
    const admin = createAdminClient()
    for (const m of members ?? []) { const u = (await admin.auth.admin.getUserById(m.user_id)).data.user; if (u?.email) emails.set(m.user_id, u.email) }
  }
  const allow = parseEmailList(process.env.AUTH_ALLOWED_EMAILS)
  return (
    <>
      <PageHeader title="Users" description="There is no public sign-up. Only emails in AUTH_ALLOWED_EMAILS can sign in; the owner then adds them here." />
      <p className="mb-4 text-xs text-slate-400">Allow-list: {allow.size ? `${allow.size} email(s) configured` : <span className="text-amber-300">AUTH_ALLOWED_EMAILS is empty — only existing accounts can sign in</span>}</p>
      {owner && (
        <Panel title="Add member" className="mb-4">
          <ActionForm action={addMember} className="grid gap-3 sm:grid-cols-[1fr_160px_auto] sm:items-end sm:space-y-0">
            <Field label="Email"><Input name="email" type="email" required /></Field>
            <Field label="Role"><Select name="role" options={[{ value: 'editor', label: 'Editor' }, { value: 'viewer', label: 'Viewer' }, { value: 'admin', label: 'Admin' }]} /></Field>
            <SubmitButton>Add</SubmitButton>
          </ActionForm>
        </Panel>
      )}
      <DataTable rows={(members ?? []).map(m => ({ ...m, id: m.user_id }))} empty="No members." columns={[
        { key: 'u', label: 'User', render: m => <span>{emails.get(m.user_id) ?? <span className="font-mono text-xs">{m.user_id.slice(0, 8)}</span>}{m.user_id === user.id && ' (you)'}</span> },
        { key: 'r', label: 'Role', render: m => <StatusPill tone={m.role === 'owner' ? 'ok' : 'info'}>{m.role}</StatusPill> },
        { key: 'd', label: 'Since', render: m => fmtDate(m.created_at, false) },
        { key: 'a', label: '', render: m => owner && m.role !== 'owner' && m.user_id !== user.id && (
          <ActionForm action={changeMember} className="flex gap-1 space-y-0">
            <input type="hidden" name="userId" value={m.user_id} />
            <Select name="action" aria-label="Change" options={[{ value: 'editor', label: 'Make editor' }, { value: 'viewer', label: 'Make viewer' }, { value: 'admin', label: 'Make admin' }, { value: 'remove', label: 'Remove' }]} className="py-1 text-xs" />
            <SubmitButton tone="ghost" className="px-2 py-1 text-xs">Apply</SubmitButton>
          </ActionForm>
        ) },
      ]} />
      <p className="mt-4 text-xs text-slate-500">Roles — owner: everything; admin: policies, agents, social accounts, high-risk approvals; editor: content, approvals, agents tasks; viewer: read only.</p>
    </>
  )
}
