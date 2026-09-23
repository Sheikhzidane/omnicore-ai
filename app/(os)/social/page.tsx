import Link from 'next/link'
import { SOCIAL_ADAPTERS, SOCIAL_PLATFORMS } from '@/lib/social/adapters'
import { PageHeader, Panel, StatusPill } from '@/components/shell/page-header'

export const dynamic = 'force-dynamic'

export default function SocialPage() {
  return (
    <>
      <PageHeader title="Social Accounts" description="Every platform is DISCONNECTED until you complete its OAuth connection (a later phase). Nothing is posted or simulated." />
      <div className="grid gap-3 md:grid-cols-2">
        {SOCIAL_PLATFORMS.map(p => {
          const adapter = SOCIAL_ADAPTERS[p]
          const { connection, integration } = adapter.status(process.env)
          return (
            <Link key={p} href={`/social/${p}`} className="block">
              <Panel className="h-full hover:border-slate-600">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-slate-100">{adapter.displayName}</span>
                  <StatusPill tone="off">{connection === 'not_configured' ? 'Disconnected · not configured' : 'Disconnected'}</StatusPill>
                </div>
                {integration.missing.length > 0 && (
                  <p className="mt-2 text-xs text-slate-500">Missing server env: {integration.missing.join(', ')}</p>
                )}
              </Panel>
            </Link>
          )
        })}
      </div>
    </>
  )
}
