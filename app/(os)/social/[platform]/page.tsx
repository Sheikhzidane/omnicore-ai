import { notFound } from 'next/navigation'
import { SOCIAL_ADAPTERS } from '@/lib/social/adapters'
import { PageHeader, Panel, StatusPill } from '@/components/shell/page-header'
import type { SocialPlatform } from '@/types/database'

export const dynamic = 'force-dynamic'

export default async function PlatformPage({ params }: { params: Promise<{ platform: string }> }) {
  const { platform } = await params
  const adapter = SOCIAL_ADAPTERS[platform as SocialPlatform]
  if (!adapter) notFound()
  const { connection, integration } = adapter.status(process.env)

  return (
    <>
      <PageHeader title={adapter.displayName} description={integration.purpose} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Connection">
          <StatusPill tone="off">{connection === 'not_configured' ? 'DISCONNECTED / NOT CONFIGURED' : 'DISCONNECTED'}</StatusPill>
          <p className="mt-3 text-sm text-slate-400">
            {connection === 'not_configured'
              ? `The app credentials for ${adapter.displayName} are not configured on the server.`
              : 'App credentials are present. Account connection (OAuth) is built in a later phase.'}
          </p>
          {integration.missing.length > 0 && (
            <p className="mt-2 text-xs text-slate-500">Missing server environment variables: <span className="font-mono">{integration.missing.join(', ')}</span></p>
          )}
        </Panel>
        <Panel title="Platform requirements">
          <p className="text-sm text-slate-400">{integration.externalRequirements}</p>
          <p className="mt-3 text-xs text-slate-500">
            Capabilities are limited to publishing approved content and reading this account&apos;s own metrics.
            No DMs, follows or engagement automation exist in this integration.
          </p>
        </Panel>
      </div>
    </>
  )
}
