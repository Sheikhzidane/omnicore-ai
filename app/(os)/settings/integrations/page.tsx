import { integrationStates } from '@/lib/config/integrations'
import { PageHeader, StatusPill } from '@/components/shell/page-header'
import { DataTable } from '@/components/ui/table'

export const dynamic = 'force-dynamic'

export default async function IntegrationsPage() {
  const rows = integrationStates(process.env)
  return (
    <>
      <PageHeader title="Integrations" description="Server-side configuration status. Variable names are shown, values never are. See docs/ENVIRONMENT.md." />
      <DataTable rows={rows} empty="" columns={[
        { key: 'n', label: 'Integration', render: i => <div><p className="text-slate-200">{i.name}</p><p className="text-xs text-slate-500">{i.purpose}</p></div> },
        { key: 'c', label: 'Category', render: i => i.category },
        { key: 's', label: 'Status', render: i => <StatusPill tone={i.status === 'configured' ? 'ok' : 'off'}>{i.status === 'configured' ? 'configured' : 'not configured'}</StatusPill> },
        { key: 'm', label: 'Missing', render: i => <span className="text-xs">{i.missing.join(', ') || '—'}</span> },
        { key: 'e', label: 'External requirements', render: i => <span className="text-xs text-slate-400">{i.externalRequirements ?? '—'}</span> },
      ]} />
    </>
  )
}
