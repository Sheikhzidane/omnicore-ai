import { createClient } from '@/lib/supabase/server'
import { listCharacters } from '@/lib/data/characters'
import { formatMoney } from '@/lib/monetisation/finance'
import { PageHeader, Panel, StatusPill } from '@/components/shell/page-header'
import { ActionForm, Field, Input, Select, SubmitButton, Textarea } from '@/components/ui/form'
import { CharacterSelect } from '@/components/ui/character-select'
import { DataTable, fmtDate } from '@/components/ui/table'
import { addContact, addDeal, addLead, optOutContact, salesAgent, setDealStatus, setLeadStage } from '../actions'

export const dynamic = 'force-dynamic'

const STAGES = ['prospect', 'researched', 'pitched', 'replied', 'negotiating', 'won', 'lost']
const DEAL = ['negotiating', 'contracted', 'in_production', 'delivered', 'invoiced', 'paid', 'cancelled']

export default async function BrandDealsPage() {
  const supabase = await createClient()
  const [chars, { data: contacts }, { data: leads }, { data: deals }] = await Promise.all([
    listCharacters(), supabase.from('brand_contacts').select('*').order('brand_name'),
    supabase.from('leads').select('*').order('updated_at', { ascending: false }), supabase.from('brand_deals').select('*').order('created_at', { ascending: false }),
  ])
  const name = (id: string | null) => chars.find(c => c.id === id)?.name ?? '—'
  return (
    <>
      <PageHeader title="Brand Deals" description="Contacts (with a lawful basis), leads, and deals. Outreach is drafted by the Sales agent and sent only after approval — one recipient at a time." />
      <div className="mb-4 grid gap-4 xl:grid-cols-3">
        <Panel title="Add contact">
          <ActionForm action={addContact}>
            <Field label="Brand"><Input name="brandName" required maxLength={200} /></Field>
            <div className="grid grid-cols-2 gap-2"><Field label="Name"><Input name="fullName" maxLength={200} /></Field><Field label="Role"><Input name="roleTitle" maxLength={200} /></Field></div>
            <Field label="Business email"><Input name="email" type="email" /></Field>
            <Field label="Why may we contact them?"><Select name="consentBasis" options={[{ value: 'published_business_contact', label: 'Published business contact (e.g. partnerships@)' }, { value: 'inbound', label: 'They contacted us' }, { value: 'referral', label: 'Referral / introduction' }, { value: 'existing_relationship', label: 'Existing relationship' }]} /></Field>
            <SubmitButton>Add contact</SubmitButton>
          </ActionForm>
        </Panel>
        <Panel title="Add lead">
          <ActionForm action={addLead}>
            <CharacterSelect characters={chars} />
            <Field label="Brand"><Input name="brandName" required maxLength={200} /></Field>
            <Field label="Contact"><Select name="contactId" options={[{ value: '', label: '—' }, ...(contacts ?? []).filter(c => !c.do_not_contact).map(c => ({ value: c.id, label: `${c.brand_name}${c.full_name ? ` · ${c.full_name}` : ''}` }))]} /></Field>
            <Field label="Website"><Input name="website" type="url" /></Field>
            <Field label="Estimated value"><Input name="estimatedValue" inputMode="decimal" placeholder="1500" /></Field>
            <Field label="Notes"><Textarea name="notes" rows={2} maxLength={4000} /></Field>
            <SubmitButton>Add lead</SubmitButton>
          </ActionForm>
        </Panel>
        <Panel title="Add deal">
          <ActionForm action={addDeal}>
            <CharacterSelect characters={chars} required />
            <Field label="Title"><Input name="title" required maxLength={300} /></Field>
            <div className="grid grid-cols-2 gap-2"><Field label="Value"><Input name="value" inputMode="decimal" defaultValue="0" /></Field><Field label="Currency"><Input name="currency" defaultValue="USD" maxLength={3} /></Field></div>
            <Field label="From lead"><Select name="leadId" options={[{ value: '', label: '—' }, ...(leads ?? []).map(l => ({ value: l.id, label: l.brand_name }))]} /></Field>
            <Field label="Deliverables (one per line)"><Textarea name="deliverables" rows={2} /></Field>
            <Field label="Due"><Input name="dueDate" type="date" /></Field>
            <SubmitButton>Add deal</SubmitButton>
          </ActionForm>
        </Panel>
      </div>

      <Panel title="Deals" className="mb-4">
        <DataTable rows={deals ?? []} empty="No deals." columns={[
          { key: 't', label: 'Deal', render: d => <div><p>{d.title}</p><p className="text-xs text-slate-500">{name(d.character_id)}</p></div> },
          { key: 'v', label: 'Value', render: d => formatMoney(d.value_cents, d.currency) },
          { key: 'd', label: 'Due', render: d => d.due_date ?? '—' },
          { key: 's', label: 'Status', render: d => (
            <ActionForm action={setDealStatus} className="flex gap-1 space-y-0"><input type="hidden" name="id" value={d.id} /><Select name="status" defaultValue={d.status} aria-label="Deal status" options={DEAL.map(s => ({ value: s, label: s.replace('_', ' ') }))} className="py-1 text-xs" /><SubmitButton tone="ghost" className="px-2 py-1 text-xs">Set</SubmitButton></ActionForm>
          ) },
        ]} />
      </Panel>

      <Panel title="Leads" className="mb-4">
        <DataTable rows={leads ?? []} empty="No leads." columns={[
          { key: 'b', label: 'Brand', render: l => <div><p>{l.brand_name}</p><p className="text-xs text-slate-500">{name(l.character_id)}</p></div> },
          { key: 'f', label: 'Fit', render: l => l.fit_score !== null ? <span title={l.fit_reasoning ?? ''}>{l.fit_score}/10</span> : '—' },
          { key: 's', label: 'Stage', render: l => (
            <ActionForm action={setLeadStage} className="flex gap-1 space-y-0"><input type="hidden" name="id" value={l.id} /><Select name="stage" defaultValue={l.stage} aria-label="Lead stage" options={STAGES.map(s => ({ value: s, label: s }))} className="py-1 text-xs" /><SubmitButton tone="ghost" className="px-2 py-1 text-xs">Set</SubmitButton></ActionForm>
          ) },
          { key: 'a', label: 'Sales agent', render: l => (
            <div className="flex gap-1">
              <ActionForm action={salesAgent}><input type="hidden" name="leadId" value={l.id} /><input type="hidden" name="what" value="score" /><SubmitButton tone="ghost" className="px-2 py-1 text-xs">Score fit</SubmitButton></ActionForm>
              {l.contact_id && <ActionForm action={salesAgent}><input type="hidden" name="leadId" value={l.id} /><input type="hidden" name="what" value="outreach" /><SubmitButton tone="ghost" className="px-2 py-1 text-xs">Draft outreach</SubmitButton></ActionForm>}
            </div>
          ) },
        ]} />
      </Panel>

      <Panel title="Contacts">
        <DataTable rows={contacts ?? []} empty="No contacts." columns={[
          { key: 'b', label: 'Brand', render: c => c.brand_name },
          { key: 'n', label: 'Contact', render: c => <span>{c.full_name ?? '—'} <span className="text-xs text-slate-500">{c.email ?? ''}</span></span> },
          { key: 'l', label: 'Basis', render: c => c.consent_basis.replaceAll('_', ' ') },
          { key: 's', label: 'Status', render: c => c.do_not_contact ? <StatusPill tone="warn">do not contact · {fmtDate(c.opted_out_at, false)}</StatusPill> : <StatusPill tone="ok">ok</StatusPill> },
          { key: 'x', label: '', render: c => !c.do_not_contact && <ActionForm action={optOutContact}><input type="hidden" name="id" value={c.id} /><SubmitButton tone="ghost" className="px-2 py-1 text-xs">Opted out</SubmitButton></ActionForm> },
        ]} />
      </Panel>
    </>
  )
}
