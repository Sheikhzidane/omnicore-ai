import { requireWorkspace } from '@/lib/auth/session'
import { integrationStates } from '@/lib/config/integrations'
import { PageHeader, Panel, StatusPill } from '@/components/shell/page-header'
import { PROHIBITED_AUTOMATION } from '@/lib/safety/prohibited'
import { HARD_BLOCKED_CATEGORIES } from '@/lib/safety/policy'

export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
  const { workspace, role, user } = await requireWorkspace()
  // Presence-only status: variable NAMES are shown, never values.
  const integrations = integrationStates(process.env)

  return (
    <>
      <PageHeader title="Settings" description="Workspace, integrations and safety" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Workspace">
          <dl className="grid grid-cols-3 gap-y-2 text-sm">
            <dt className="text-slate-500">Name</dt><dd className="col-span-2 text-slate-200">{workspace.name}</dd>
            <dt className="text-slate-500">Your role</dt><dd className="col-span-2 text-slate-200">{role}</dd>
            <dt className="text-slate-500">Signed in as</dt><dd className="col-span-2 text-slate-200">{user.email}</dd>
          </dl>
        </Panel>
        <Panel title="Integrations (server-side configuration)">
          <ul className="space-y-2 text-sm">
            {integrations.map(i => (
              <li key={i.id} className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-slate-200">{i.name}</p>
                  {i.missing.length > 0 && <p className="text-[11px] text-slate-500">Missing: {i.missing.join(', ')}</p>}
                </div>
                <StatusPill tone={i.status === 'configured' ? 'info' : 'off'}>
                  {i.status === 'configured' ? 'Configured (unverified)' : 'Not configured'}
                </StatusPill>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title="Never permitted (not configurable)">
          <ul className="list-disc space-y-1 pl-4 text-xs text-slate-400">
            {Object.values(PROHIBITED_AUTOMATION).map(v => <li key={v}>{v}</li>)}
          </ul>
        </Panel>
        <Panel title="Hard-blocked content categories">
          <ul className="list-disc space-y-1 pl-4 text-xs text-slate-400">
            {HARD_BLOCKED_CATEGORIES.map(c => <li key={c}>{c.replaceAll('_', ' ')}</li>)}
          </ul>
        </Panel>
      </div>
    </>
  )
}
