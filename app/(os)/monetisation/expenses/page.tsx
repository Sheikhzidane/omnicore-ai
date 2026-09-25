import { createClient } from '@/lib/supabase/server'
import { listCharacters } from '@/lib/data/characters'
import { formatMoney } from '@/lib/monetisation/finance'
import { PageHeader, Panel } from '@/components/shell/page-header'
import { ActionForm, Field, Input, Select, SubmitButton } from '@/components/ui/form'
import { CharacterSelect } from '@/components/ui/character-select'
import { DataTable } from '@/components/ui/table'
import { addExpense } from '../actions'

export const dynamic = 'force-dynamic'

export default async function ExpensesPage() {
  const supabase = await createClient()
  const [chars, { data }] = await Promise.all([listCharacters(), supabase.from('expenses').select('*').order('occurred_on', { ascending: false }).limit(300)])
  return (
    <>
      <PageHeader title="Expenses" description="Costs you record, plus AI compute recorded automatically for each agent run and image generation (rounded to cents; exact figures are in AI Agents → Runs)." />
      <Panel title="Record expense" className="mb-4">
        <ActionForm action={addExpense}>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <CharacterSelect characters={chars} />
            <Field label="Category"><Select name="category" options={['software', 'ads', 'production', 'contractor', 'fees', 'ai_compute', 'other'].map(s => ({ value: s, label: s.replace('_', ' ') }))} /></Field>
            <Field label="Amount"><Input name="amount" inputMode="decimal" required /></Field>
            <Field label="Currency"><Input name="currency" defaultValue="USD" maxLength={3} /></Field>
            <Field label="Date"><Input name="occurredOn" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required /></Field>
            <Field label="Vendor"><Input name="vendor" maxLength={200} /></Field>
            <Field label="Description"><Input name="description" maxLength={500} /></Field>
          </div>
          <SubmitButton>Record</SubmitButton>
        </ActionForm>
      </Panel>
      <DataTable rows={data ?? []} empty="No expenses recorded." columns={[
        { key: 'd', label: 'Date', render: e => e.occurred_on },
        { key: 'c', label: 'Character', render: e => chars.find(c => c.id === e.character_id)?.name ?? '—' },
        { key: 'k', label: 'Category', render: e => e.category.replace('_', ' ') },
        { key: 'v', label: 'Vendor', render: e => e.vendor ?? '—' },
        { key: 'a', label: 'Amount', render: e => formatMoney(e.amount_cents, e.currency) },
        { key: 'x', label: 'Description', render: e => <span className="text-xs text-slate-500">{e.description ?? ''}</span> },
      ]} />
    </>
  )
}
