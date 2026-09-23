import { createClient } from '@/lib/supabase/server'
import { ModuleIndex, Panel } from '@/components/shell/module-pages'
import { StatusPill } from '@/components/shell/page-header'
import { AGENT_CAPABILITIES, ROLE_CAPABILITIES, ROLE_LABELS, agentsGloballyEnabled } from '@/lib/agents/permissions'
import type { AgentRole } from '@/types/database'

export const dynamic = 'force-dynamic'

export default async function AgentsPage() {
  const supabase = await createClient()
  const { data: agents } = await supabase.from('agents').select('id, role, status, autonomy')
  const enabled = agentsGloballyEnabled(process.env)
  const roles = Object.keys(ROLE_CAPABILITIES) as AgentRole[]

  return (
    <ModuleIndex href="/agents">
      <Panel title="Agent Control Centre" className="mb-6">
        <div className="mb-4 flex items-center gap-3 text-sm">
          Global kill switch (AGENTS_ENABLED):
          <StatusPill tone={enabled ? 'warn' : 'off'}>{enabled ? 'Agents may run' : 'All agents stopped'}</StatusPill>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {roles.map(role => {
            const instances = (agents ?? []).filter(a => a.role === role)
            const active = instances.filter(a => a.status === 'active').length
            return (
              <div key={role} className="rounded border border-slate-800 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-slate-100">{ROLE_LABELS[role]} Agent</span>
                  <StatusPill tone={active > 0 ? 'ok' : 'off'}>{instances.length === 0 ? 'Not created' : `${active}/${instances.length} active`}</StatusPill>
                </div>
                <ul className="mt-2 space-y-0.5 text-[11px] text-slate-400">
                  {ROLE_CAPABILITIES[role].map(c => (
                    <li key={c}>
                      {AGENT_CAPABILITIES[c].description}
                      {AGENT_CAPABILITIES[c].sideEffect && <span className="text-amber-400/80"> · needs approval</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </div>
        <p className="mt-4 text-xs text-slate-500">
          Agents never receive file, git, SQL, shell, credential or security-configuration access. Agent execution is built in Phase 5.
        </p>
      </Panel>
    </ModuleIndex>
  )
}
