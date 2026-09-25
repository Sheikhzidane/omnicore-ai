import { requireWorkspace } from '@/lib/auth/session'
import { hasRole } from '@/lib/auth/roles'
import { PageHeader, Panel } from '@/components/shell/page-header'
import { ActionForm, Field, Input, SubmitButton } from '@/components/ui/form'
import { renameWorkspace } from './actions'

export const dynamic = 'force-dynamic'

export default async function WorkspaceSettings() {
  const { workspace, role, user } = await requireWorkspace()
  return (
    <>
      <PageHeader title="Workspace" description="Workspace details. All data is isolated per workspace by row-level security." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Details">
          <dl className="grid grid-cols-3 gap-y-2 text-sm">
            <dt className="text-slate-500">Name</dt><dd className="col-span-2 text-slate-200">{workspace.name}</dd>
            <dt className="text-slate-500">Workspace id</dt><dd className="col-span-2 break-all font-mono text-xs text-slate-400">{workspace.id}</dd>
            <dt className="text-slate-500">Your role</dt><dd className="col-span-2 text-slate-200">{role}</dd>
            <dt className="text-slate-500">Signed in as</dt><dd className="col-span-2 text-slate-200">{user.email}</dd>
          </dl>
        </Panel>
        {hasRole(role, 'owner') && (
          <Panel title="Rename">
            <ActionForm action={renameWorkspace}><Field label="Name"><Input name="name" defaultValue={workspace.name} required maxLength={120} /></Field><SubmitButton>Save</SubmitButton></ActionForm>
          </Panel>
        )}
      </div>
    </>
  )
}
