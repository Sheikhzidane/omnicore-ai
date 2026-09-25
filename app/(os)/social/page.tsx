import { createClient } from '@/lib/supabase/server'
import { requireWorkspace } from '@/lib/auth/session'
import { hasRole } from '@/lib/auth/roles'
import { selectedCharacter } from '@/lib/data/characters'
import { SOCIAL_PROVIDERS } from '@/lib/social/providers'
import { integrationState } from '@/lib/config/integrations'
import { PageHeader, Panel, StatusPill } from '@/components/shell/page-header'
import { CharacterFilter, NoCharacters } from '@/components/shell/character-filter'
import { ActionForm, SubmitButton } from '@/components/ui/form'
import { NotConfigured, fmtDate } from '@/components/ui/table'
import { disconnectAccount } from './actions'

export const dynamic = 'force-dynamic'

const RESULTS: Record<string, string> = {
  connected: 'Account connected.', denied: 'You cancelled the authorisation.', invalid_state: 'The connection link expired or was tampered with. Try again.',
  missing_code: 'The platform did not return an authorisation code.', error: 'Connection failed — see the account error below.', unknown_platform: 'Unknown platform.',
}

export default async function SocialPage({ searchParams }: { searchParams: Promise<{ character?: string; result?: string }> }) {
  const sp = await searchParams
  const { role } = await requireWorkspace()
  const { all, current } = await selectedCharacter(sp.character)
  if (!current) return <><PageHeader title="Social Accounts" /><NoCharacters /></>
  const supabase = await createClient()
  const [{ data: accounts }, { data: meta }] = await Promise.all([
    supabase.from('social_accounts').select('*').eq('character_id', current.id),
    supabase.from('social_credentials_metadata').select('social_account_id, expires_at, status, scopes'),
  ])
  const vault = Boolean(process.env.CREDENTIALS_ENCRYPTION_KEY)
  const site = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, '') ?? ''
  const isAdmin = hasRole(role, 'admin')
  return (
    <>
      <PageHeader title="Social Accounts" description="Connect each character's own accounts through the platform's official OAuth. Tokens are encrypted and never shown." />
      <CharacterFilter path="/social" characters={all} current={current.id} />
      {sp.result && RESULTS[sp.result] && <p role="status" className={`mb-4 rounded border px-3 py-2 text-sm ${sp.result === 'connected' ? 'border-emerald-900 text-emerald-200' : 'border-amber-900 text-amber-200'}`}>{RESULTS[sp.result]}</p>}
      {!vault && <div className="mb-4"><NotConfigured what="The credential vault" missing={['CREDENTIALS_ENCRYPTION_KEY']}>Accounts cannot be connected until tokens can be encrypted.</NotConfigured></div>}
      <div className="grid gap-4 lg:grid-cols-2">
        {Object.values(SOCIAL_PROVIDERS).map(p => {
          const integration = integrationState(p.integrationId, process.env)
          const acct = accounts?.find(a => a.platform === p.platform)
          const m = acct ? meta?.find(x => x.social_account_id === acct.id) : null
          const connected = acct?.status === 'connected'
          return (
            <Panel key={p.platform}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-medium text-slate-100">{p.displayName}</h2>
                <StatusPill tone={connected ? 'ok' : acct?.status === 'error' ? 'warn' : 'off'}>{integration.status !== 'configured' ? 'not configured' : acct?.status ?? 'not connected'}</StatusPill>
              </div>
              {connected && (
                <dl className="mt-2 space-y-1 text-xs text-slate-400">
                  <div>Account: <span className="text-slate-200">@{acct!.handle ?? acct!.external_account_id}</span></div>
                  <div>Connected: {fmtDate(acct!.connected_at)}</div>
                  {m?.expires_at && <div>Token expires: {fmtDate(m.expires_at)} ({m.status})</div>}
                  <div>Scopes: {acct!.scopes.join(', ') || '—'}</div>
                </dl>
              )}
              {acct?.last_error && <p className="mt-2 text-xs text-red-300">{acct.last_error}</p>}
              <ul className="mt-3 space-y-1 text-xs text-slate-500">{p.requirements.map(r => <li key={r}>• {r}</li>)}</ul>
              <div className="mt-3 flex flex-wrap gap-2">
                {integration.status !== 'configured' ? (
                  <NotConfigured what={`${p.displayName} app credentials`} missing={integration.missing} />
                ) : isAdmin && vault ? (
                  <a href={`/api/social/connect/${p.platform}?characterId=${current.id}`} className="rounded-md bg-cyan-600 px-3 py-2 text-sm font-medium text-white hover:bg-cyan-500">{connected ? 'Reconnect' : 'Connect'}</a>
                ) : null}
                {connected && isAdmin && <ActionForm action={disconnectAccount}><input type="hidden" name="accountId" value={acct!.id} /><SubmitButton tone="ghost">Disconnect</SubmitButton></ActionForm>}
              </div>
              {site && <p className="mt-3 break-all text-[11px] text-slate-500">OAuth redirect URI: <code>{site}/api/social/callback/{p.platform}</code>{p.capabilities.webhooks && <><br />Webhook URL: <code>{site}/api/social-webhooks/{p.platform}</code></>}</p>}
            </Panel>
          )
        })}
      </div>
      <p className="mt-4 text-xs text-slate-500">These integrations follow each platform&apos;s published API and are unit-tested, but have not been verified against the live platforms from this codebase. Verify with a test account first (docs/SOCIAL_INTEGRATIONS.md).</p>
    </>
  )
}
