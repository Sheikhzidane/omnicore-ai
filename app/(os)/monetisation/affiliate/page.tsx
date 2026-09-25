import { createClient } from '@/lib/supabase/server'
import { listCharacters } from '@/lib/data/characters'
import { formatMoney } from '@/lib/monetisation/finance'
import { PageHeader, Panel, StatusPill } from '@/components/shell/page-header'
import { ActionForm, Field, Input, Select, SubmitButton } from '@/components/ui/form'
import { CharacterSelect } from '@/components/ui/character-select'
import { DataTable } from '@/components/ui/table'
import { addAffiliateLink, setAffiliateStatus } from '../actions'

export const dynamic = 'force-dynamic'

export default async function AffiliatePage() {
  const supabase = await createClient()
  const [chars, { data: links }, { data: rev }] = await Promise.all([
    listCharacters(), supabase.from('affiliate_links').select('*').order('created_at', { ascending: false }),
    supabase.from('revenue').select('affiliate_link_id, amount_cents, currency, status').eq('source_type', 'affiliate').eq('status', 'received'),
  ])
  const earned = (id: string) => (rev ?? []).filter(r => r.affiliate_link_id === id).reduce<Record<string, number>>((m, r) => ({ ...m, [r.currency]: (m[r.currency] ?? 0) + r.amount_cents }), {})
  return (
    <>
      <PageHeader title="Affiliate Links" description="Every affiliate link carries a disclosure. Earnings come from revenue entries you record (or import)." />
      <Panel title="Add link" className="mb-4">
        <ActionForm action={addAffiliateLink}>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <CharacterSelect characters={chars} />
            <Field label="Program"><Input name="program" required maxLength={120} /></Field>
            <Field label="Merchant"><Input name="merchant" maxLength={120} /></Field>
            <Field label="Destination URL (https)"><Input name="destinationUrl" type="url" required /></Field>
            <Field label="Tracking URL (https)"><Input name="trackingUrl" type="url" /></Field>
            <Field label="Discount code"><Input name="code" maxLength={60} /></Field>
            <Field label="Commission type"><Select name="commissionType" options={['unknown', 'percent', 'fixed', 'hybrid'].map(v => ({ value: v, label: v }))} /></Field>
            <Field label="Commission rate"><Input name="commissionRate" type="number" step="0.01" min={0} /></Field>
            <Field label="Disclosure text"><Input name="disclosureText" placeholder="Affiliate link — I may earn a commission." maxLength={300} /></Field>
          </div>
          <SubmitButton>Add link</SubmitButton>
        </ActionForm>
      </Panel>
      <DataTable rows={links ?? []} empty="No affiliate links." columns={[
        { key: 'p', label: 'Program', render: l => <div><p>{l.program}</p><p className="break-all text-xs text-slate-500">{l.tracking_url ?? l.destination_url}</p></div> },
        { key: 'c', label: 'Commission', render: l => l.commission_rate !== null ? `${l.commission_rate}${l.commission_type === 'percent' ? '%' : ''} (${l.commission_type})` : l.commission_type },
        { key: 'd', label: 'Disclosure', render: l => <span className="text-xs">{l.disclosure_text}</span> },
        { key: 'e', label: 'Earned', render: l => Object.entries(earned(l.id)).map(([c, v]) => formatMoney(v, c)).join(', ') || '—' },
        { key: 's', label: 'Status', render: l => <StatusPill tone={l.status === 'active' ? 'ok' : 'off'}>{l.status}</StatusPill> },
        { key: 'x', label: '', render: l => <ActionForm action={setAffiliateStatus}><input type="hidden" name="id" value={l.id} /><input type="hidden" name="status" value={l.status === 'active' ? 'paused' : 'active'} /><SubmitButton tone="ghost" className="px-2 py-1 text-xs">{l.status === 'active' ? 'Pause' : 'Activate'}</SubmitButton></ActionForm> },
      ]} />
    </>
  )
}
