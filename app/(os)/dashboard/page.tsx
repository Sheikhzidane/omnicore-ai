import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { requireWorkspace } from '@/lib/auth/session'
import { integrationStates } from '@/lib/config/integrations'
import { agentsGloballyEnabled } from '@/lib/agents/permissions'
import { aiProviderSummary } from '@/lib/ai/registry'
import { PageHeader, Panel, StatusPill } from '@/components/shell/page-header'
import { fmtDate } from '@/components/ui/table'

export const dynamic = 'force-dynamic'

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { workspace, role } = await requireWorkspace()
  const { error } = await searchParams
  const supabase = await createClient()
  const head = { count: 'exact' as const, head: true }
  const since = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').toISOString()
  const [chars, accounts, approvals, scheduled, published, failedJobs, runs, audit, upcoming] = await Promise.all([
    supabase.from('characters').select('id', head),
    supabase.from('social_accounts').select('id', head).eq('status', 'connected'),
    supabase.from('agent_approvals').select('id', head).eq('status', 'AWAITING_APPROVAL'),
    supabase.from('publishing_jobs').select('id', head).eq('status', 'queued'),
    supabase.from('content_items').select('id', head).eq('status', 'published'),
    supabase.from('publishing_jobs').select('id', head).in('status', ['failed', 'blocked']),
    supabase.from('agent_runs').select('cost_usd').gte('started_at', since),
    supabase.from('audit_log').select('id, action, outcome, created_at').eq('workspace_id', workspace.id).order('created_at', { ascending: false }).limit(8),
    supabase.from('publishing_jobs').select('id, content_item_id, platform, scheduled_for').eq('status', 'queued').order('scheduled_for').limit(5),
  ])
  const integrations = integrationStates(process.env)
  const ai = aiProviderSummary()
  const agentsOn = agentsGloballyEnabled(process.env)
  const spend = (runs.data ?? []).reduce((s, r) => s + Number(r.cost_usd), 0)

  const stats = [
    { label: 'Awaiting your approval', value: approvals.count ?? 0, href: '/agents/approvals' },
    { label: 'Scheduled posts', value: scheduled.count ?? 0, href: '/content/publishing' },
    { label: 'Published posts', value: published.count ?? 0, href: '/content/history?status=published' },
    { label: 'Publishing problems', value: failedJobs.count ?? 0, href: '/content/publishing' },
    { label: 'Characters', value: chars.count ?? 0, href: '/characters' },
    { label: 'Connected accounts', value: accounts.count ?? 0, href: '/social' },
    { label: 'AI spend today', value: `$${spend.toFixed(2)}`, href: '/agents/runs' },
    { label: 'Integrations configured', value: `${integrations.filter(i => i.status === 'configured').length} / ${integrations.length}`, href: '/settings/integrations' },
  ]

  return (
    <>
      <PageHeader title="Dashboard" description={`${workspace.name} · your role: ${role}`} />
      {error === 'ops_forbidden' && <p role="alert" className="mb-4 rounded border border-amber-900 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">/ops is restricted to platform admins.</p>}
      {error === 'forbidden' && <p role="alert" className="mb-4 rounded border border-amber-900 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">Your role does not allow that page.</p>}
      {(chars.count ?? 0) === 0 && (
        <Panel className="mb-4">
          <p className="text-sm text-slate-300">Get started: <Link href="/characters/new" className="text-cyan-300 hover:underline">create a character</Link> → connect its accounts in <Link href="/social" className="text-cyan-300 hover:underline">Social Accounts</Link> → set <Link href="/settings/publishing-policies" className="text-cyan-300 hover:underline">publishing policies</Link> → create content.</p>
        </Panel>
      )}
      <div className="mb-6 grid grid-cols-2 gap-3 xl:grid-cols-4">
        {stats.map(s => (
          <Link key={s.label} href={s.href} className="rounded-lg border border-slate-800 bg-slate-900/40 p-4 hover:border-slate-600">
            <p className="text-xs text-slate-400">{s.label}</p>
            <p className="mt-1 text-2xl font-semibold text-slate-100">{s.value}</p>
          </Link>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Safety & system">
          <ul className="space-y-2 text-sm text-slate-300">
            <li className="flex items-center justify-between gap-2">Human approval before publishing <StatusPill tone="ok">On</StatusPill></li>
            <li className="flex items-center justify-between gap-2">AI-character disclosure <StatusPill tone="ok">Enforced</StatusPill></li>
            <li className="flex items-center justify-between gap-2">Agents (AGENTS_ENABLED) <StatusPill tone={agentsOn ? 'warn' : 'off'}>{agentsOn ? 'Enabled' : 'Stopped'}</StatusPill></li>
            <li className="flex items-center justify-between gap-2">Text AI <StatusPill tone={ai.text ? 'ok' : 'off'}>{ai.text ?? 'not configured'}</StatusPill></li>
            <li className="flex items-center justify-between gap-2">Moderation <StatusPill tone={ai.moderation ? 'ok' : 'warn'}>{ai.moderation ?? 'human review'}</StatusPill></li>
            <li className="flex items-center justify-between gap-2">Scheduler (CRON_SECRET) <StatusPill tone={process.env.CRON_SECRET ? 'ok' : 'warn'}>{process.env.CRON_SECRET ? 'configured' : 'not configured'}</StatusPill></li>
          </ul>
        </Panel>
        <Panel title="Next scheduled">
          {(upcoming.data ?? []).length ? (
            <ul className="space-y-1 text-sm">{upcoming.data!.map(j => <li key={j.id}><Link href={`/content/items/${j.content_item_id}`} className="text-cyan-300 hover:underline">{j.platform}</Link> <span className="text-xs text-slate-400">{fmtDate(j.scheduled_for)}</span></li>)}</ul>
          ) : <p className="text-sm text-slate-500">Nothing scheduled.</p>}
        </Panel>
        <Panel title="Recent activity">
          {(audit.data ?? []).length ? (
            <ul className="space-y-1 text-xs">{audit.data!.map(a => <li key={a.id} className="flex justify-between gap-2 text-slate-400"><span className="font-mono text-slate-300">{a.action}</span><span>{a.outcome}</span></li>)}</ul>
          ) : <p className="text-sm text-slate-500">No activity yet.</p>}
        </Panel>
      </div>
    </>
  )
}
