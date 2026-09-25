import { createClient } from '@/lib/supabase/server'
import { listCharacters } from '@/lib/data/characters'
import { formatMoney } from '@/lib/monetisation/finance'
import { PageHeader, Panel, StatusPill } from '@/components/shell/page-header'
import { ActionForm, Field, Input, Select, SubmitButton } from '@/components/ui/form'
import { CharacterSelect } from '@/components/ui/character-select'
import { DataTable } from '@/components/ui/table'
import { addProduct } from '../actions'

export const dynamic = 'force-dynamic'

export default async function ProductsPage() {
  const supabase = await createClient()
  const [chars, { data: products }, { data: rev }] = await Promise.all([listCharacters(), supabase.from('products').select('*').order('created_at', { ascending: false }), supabase.from('revenue').select('product_id, amount_cents, currency').eq('status', 'received').not('product_id', 'is', null)])
  const sold = (id: string) => (rev ?? []).filter(r => r.product_id === id)
  return (
    <>
      <PageHeader title="Products" description="Digital and physical products, services and memberships. Sales are recorded from verified Stripe webhooks or entered manually." />
      <Panel title="Add product" className="mb-4">
        <ActionForm action={addProduct}>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <CharacterSelect characters={chars} />
            <Field label="Name"><Input name="name" required maxLength={200} /></Field>
            <Field label="Kind"><Select name="kind" options={['digital', 'physical', 'service', 'membership'].map(k => ({ value: k, label: k }))} /></Field>
            <Field label="Price"><Input name="price" inputMode="decimal" /></Field>
            <Field label="Currency"><Input name="currency" defaultValue="USD" maxLength={3} /></Field>
            <Field label="External reference" hint="e.g. Stripe price id"><Input name="externalRef" maxLength={200} /></Field>
          </div>
          <SubmitButton>Add product</SubmitButton>
        </ActionForm>
      </Panel>
      <DataTable rows={products ?? []} empty="No products." columns={[
        { key: 'n', label: 'Product', render: p => p.name },
        { key: 'k', label: 'Kind', render: p => p.kind },
        { key: 'p', label: 'Price', render: p => p.price_cents !== null ? formatMoney(p.price_cents, p.currency) : '—' },
        { key: 's', label: 'Sales', render: p => { const s = sold(p.id); return s.length ? `${s.length} · ${formatMoney(s.reduce((a, r) => a + r.amount_cents, 0), s[0].currency)}` : '—' } },
        { key: 'st', label: 'Status', render: p => <StatusPill tone={p.status === 'active' ? 'ok' : 'off'}>{p.status}</StatusPill> },
      ]} />
    </>
  )
}
