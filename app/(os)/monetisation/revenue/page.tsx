import { createClient } from '@/lib/supabase/server'
import { listCharacters } from '@/lib/data/characters'
import { formatMoney } from '@/lib/monetisation/finance'
import { PageHeader, Panel, StatusPill } from '@/components/shell/page-header'
import { ActionForm, Field, Input, Select, SubmitButton } from '@/components/ui/form'
import { CharacterSelect } from '@/components/ui/character-select'
import { DataTable } from '@/components/ui/table'
import { addRevenue, setRevenueStatus } from '../actions'

export const dynamic = 'force-dynamic'
const SOURCES = ['affiliate', 'sponsorship', 'product', 'subscription', 'tips', 'licensing', 'platform_payout', 'other']

export default async function RevenuePage() {
  const supabase = await createClient()
  const [chars, { data }] = await Promise.all([listCharacters(), supabase.from('revenue').select('*').order('occurred_on', { ascending: false }).limit(300)])
  const today = new Date().toISOString().slice(0, 10)
  return (
    <>
      <PageHeader title="Revenue" description="Every income entry: recorded by you, from paid deals, or from verified Stripe events." />
      <Panel title="Record revenue" className="mb-4">
        <ActionForm action={addRevenue}>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <CharacterSelect characters={chars} />
            <Field label="Source"><Select name="sourceType" options={SOURCES.map(s => ({ value: s, label: s.replace('_', ' ') }))} /></Field>
            <Field label="Amount"><Input name="amount" inputMode="decimal" required placeholder="120.00" /></Field>
            <Field label="Currency"><Input name="currency" defaultValue="USD" maxLength={3} /></Field>
            <Field label="Date"><Input name="occurredOn" type="date" defaultValue={today} required /></Field>
            <Field label="Status"><Select name="status" options={[{ value: 'received', label: 'Received' }, { value: 'pending', label: 'Pending' }, { value: 'expected', label: 'Expected' }]} /></Field>
            <Field label="Reference" hint="Payout id, invoice number…"><Input name="externalRef" maxLength={200} /></Field>
            <Field label="Description"><Input name="description" maxLength={500} /></Field>
          </div>
          <SubmitButton>Record</SubmitButton>
        </ActionForm>
      </Panel>
      <DataTable rows={data ?? []} empty="No revenue recorded." columns={[
        { key: 'd', label: 'Date', render: r => r.occurred_on },
        { key: 'c', label: 'Character', render: r => chars.find(c => c.id === r.character_id)?.name ?? '—' },
        { key: 's', label: 'Source', render: r => r.source_type.replace('_', ' ') },
        { key: 'a', label: 'Amount', render: r => formatMoney(r.amount_cents, r.currency) },
        { key: 'st', label: 'Status', render: r => <StatusPill tone={r.status === 'received' ? 'ok' : r.status === 'refunded' ? 'warn' : 'info'}>{r.status}</StatusPill> },
        { key: 'r', label: 'Ref', render: r => <span className="text-xs text-slate-500">{r.external_ref ?? r.description ?? ''}</span> },
        { key: 'x', label: '', render: r => r.status !== 'received' && r.status !== 'refunded' && <ActionForm action={setRevenueStatus}><input type="hidden" name="id" value={r.id} /><input type="hidden" name="status" value="received" /><SubmitButton tone="ghost" className="px-2 py-1 text-xs">Mark received</SubmitButton></ActionForm> },
      ]} />
    </>
  )
}
