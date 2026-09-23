import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { requireWorkspace } from '@/lib/auth/session'
import { integrationStates } from '@/lib/config/integrations'
import { agentsGloballyEnabled } from '@/lib/agents/permissions'
import { PageHeader, Panel, StatusPill } from '@/components/shell/page-header'

export const dynamic = 'force-dynamic'

async function count(table: 'characters' | 'agents' | 'agent_tasks', filter?: { column: string; value: string }) {
  const supabase = await createClient()
  let q = supabase.from(table).select('id', { count: 'exact', head: true })
  if (filter) q = q.eq(filter.column, filter.value)
  const { count: n } = await q
  return n ?? 0
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { workspace, role } = await requireWorkspace()
  const { error } = await searchParams
  const supabase = await createClient()

  const [characters, agents, activeAgents, awaitingApproval] = await Promise.all([
    count('characters'),
    count('agents'),
    count('agents', { column: 'status', value: 'active' }),
    count('agent_tasks', { column: 'status', value: 'proposed' }),
  ])
  const { data: recentAudit } = await supabase
    .from('audit_log')
    .select('id, action, outcome, created_at')
    .eq('workspace_id', workspace.id)
    .order('created_at', { ascending: false })
    .limit(8)

  const integrations = integrationStates(process.env)
  const configured = integrations.filter(i => i.status === 'configured').length
  const agentsOn = agentsGloballyEnabled(process.env)

  const stats = [
    { label: 'Characters', value: characters, href: '/characters' },
    { label: 'Agents', value: `${activeAgents} / ${agents} active`, href: '/agents' },
    { label: 'Awaiting approval', value: awaitingApproval, href: '/agents/tasks' },
    { label: 'Integrations configured', value: `${configured} / ${integrations.length}`, href: '/settings' },
  ]

  return (
    <>
      <PageHeader title="Dashboard" description={`${workspace.name} · your role: ${role}`} />
      {error === 'ops_forbidden' && (
        <p role="alert" className="mb-4 rounded border border-amber-900 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
          /ops is restricted to platform admins.
        </p>
      )}
      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map(s => (
          <Link key={s.label} href={s.href} className="rounded-lg border border-slate-800 bg-slate-900/40 p-4 hover:border-slate-600">
            <p className="text-xs text-slate-400">{s.label}</p>
            <p className="mt-1 text-2xl font-semibold text-slate-100">{s.value}</p>
          </Link>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Safety defaults">
          <ul className="space-y-2 text-sm text-slate-300">
            <li className="flex items-center justify-between">Human approval for every publish <StatusPill tone="ok">On</StatusPill></li>
            <li className="flex items-center justify-between">AI-character disclosure <StatusPill tone="ok">Always on</StatusPill></li>
            <li className="flex items-center justify-between">Sponsored-content disclosure <StatusPill tone="ok">Enforced</StatusPill></li>
            <li className="flex items-center justify-between">
              Autonomous agents (AGENTS_ENABLED)
              <StatusPill tone={agentsOn ? 'warn' : 'off'}>{agentsOn ? 'Enabled' : 'Disabled'}</StatusPill>
            </li>
          </ul>
        </Panel>
        <Panel title="Recent activity (audit log)">
          {recentAudit && recentAudit.length > 0 ? (
            <ul className="space-y-1 text-xs">
              {recentAudit.map(a => (
                <li key={a.id} className="flex justify-between gap-2 text-slate-400">
                  <span className="font-mono text-slate-300">{a.action}</span>
                  <span>{a.outcome} · {new Date(a.created_at).toLocaleString()}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-500">No workspace activity yet.</p>
          )}
        </Panel>
      </div>
    </>
  )
}
