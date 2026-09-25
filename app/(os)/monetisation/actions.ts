'use server'

import { z } from 'zod'
import { recordAudit } from '@/lib/audit'
import { runAction, formObject, type ActionResult } from '@/lib/actions'
import { parseAmountToCents } from '@/lib/monetisation/finance'
import { queueAgentTask, describeOutcome } from '@/lib/agents/runner'
import { summarise } from '@/lib/monetisation/finance'
import type { Json } from '@/types/database'

const Id = z.uuid()
const optId = z.uuid().optional()
const CUR = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default('USD')
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const PATHS = ['/monetisation/affiliate', '/monetisation/sponsorships', '/monetisation/deals', '/monetisation/products', '/monetisation/subscriptions', '/monetisation/revenue', '/monetisation/expenses', '/monetisation/roi']

export async function addAffiliateLink(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace, user }) => {
    const f = z.object({
      characterId: optId, program: z.string().trim().min(1).max(120), merchant: z.string().max(120).optional(), destinationUrl: z.url().startsWith('https://'),
      trackingUrl: z.url().startsWith('https://').optional(), code: z.string().max(60).optional(), commissionType: z.enum(['percent', 'fixed', 'hybrid', 'unknown']).default('unknown'),
      commissionRate: z.coerce.number().min(0).max(100000).optional(), disclosureText: z.string().trim().min(5).max(300).optional(),
    }).parse(formObject(fd))
    const ins = await db.from('affiliate_links').insert({
      workspace_id: workspace.id, character_id: f.characterId ?? null, program: f.program, merchant: f.merchant ?? null, destination_url: f.destinationUrl,
      tracking_url: f.trackingUrl ?? null, code: f.code ?? null, commission_type: f.commissionType, commission_rate: f.commissionRate ?? null,
      ...(f.disclosureText ? { disclosure_text: f.disclosureText } : {}),
    })
    if (ins.error) throw new Error(ins.error.message)
    await recordAudit({ workspaceId: workspace.id, actorType: 'user', actorId: user.id, action: 'monetisation.add_affiliate', details: { program: f.program } })
    return 'Affiliate link added.'
  }, PATHS)
}

export async function setAffiliateStatus(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace }) => {
    const r = await db.from('affiliate_links').update({ status: z.enum(['active', 'paused', 'expired']).parse(fd.get('status')) }).eq('workspace_id', workspace.id).eq('id', Id.parse(fd.get('id')))
    if (r.error) throw new Error(r.error.message)
  }, PATHS)
}

export async function addContact(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace, user }) => {
    const f = z.object({
      brandName: z.string().trim().min(1).max(200), fullName: z.string().max(200).optional(), email: z.email().max(320).optional(), roleTitle: z.string().max(200).optional(),
      website: z.url().optional(), consentBasis: z.enum(['published_business_contact', 'inbound', 'referral', 'existing_relationship']), notes: z.string().max(2000).optional(),
    }).parse(formObject(fd))
    const ins = await db.from('brand_contacts').insert({ workspace_id: workspace.id, brand_name: f.brandName, full_name: f.fullName ?? null, email: f.email ?? null, role_title: f.roleTitle ?? null, website: f.website ?? null, consent_basis: f.consentBasis, notes: f.notes ?? null })
    if (ins.error) throw new Error(ins.error.message)
    await recordAudit({ workspaceId: workspace.id, actorType: 'user', actorId: user.id, action: 'crm.add_contact', details: { brand: f.brandName, basis: f.consentBasis } })
    return 'Contact added.'
  }, PATHS)
}

export async function optOutContact(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace, user }) => {
    const id = Id.parse(fd.get('id'))
    const r = await db.from('brand_contacts').update({ do_not_contact: true, opted_out_at: new Date().toISOString() }).eq('workspace_id', workspace.id).eq('id', id)
    if (r.error) throw new Error(r.error.message)
    await recordAudit({ workspaceId: workspace.id, actorType: 'user', actorId: user.id, action: 'crm.opt_out', entityType: 'brand_contact', entityId: id })
    return 'Marked do-not-contact. No outreach can be sent to this contact.'
  }, PATHS)
}

export async function addLead(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace }) => {
    const f = z.object({ characterId: optId, contactId: optId, brandName: z.string().trim().min(1).max(200), website: z.url().optional(), estimatedValue: z.string().optional(), notes: z.string().max(4000).optional() }).parse(formObject(fd))
    const ins = await db.from('leads').insert({ workspace_id: workspace.id, character_id: f.characterId ?? null, contact_id: f.contactId ?? null, brand_name: f.brandName, website: f.website ?? null, estimated_value_cents: f.estimatedValue ? parseAmountToCents(f.estimatedValue) : null, notes: f.notes ?? null, source: 'manual' })
    if (ins.error) throw new Error(ins.error.message)
    return 'Lead added.'
  }, PATHS)
}

export async function setLeadStage(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace }) => {
    const stage = z.enum(['prospect', 'researched', 'pitched', 'replied', 'negotiating', 'won', 'lost']).parse(fd.get('stage'))
    const r = await db.from('leads').update({ stage, stage_changed_at: new Date().toISOString() }).eq('workspace_id', workspace.id).eq('id', Id.parse(fd.get('id')))
    if (r.error) throw new Error(r.error.message)
  }, PATHS)
}

export async function salesAgent(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace, user }) => {
    const f = formObject(fd)
    const leadId = Id.parse(f.leadId)
    const lead = (await db.from('leads').select('*').eq('workspace_id', workspace.id).eq('id', leadId).single()).data
    if (!lead) throw new Error('lead not found')
    if (!lead.character_id) throw new Error('assign the lead to a character first')
    const what = z.enum(['score', 'outreach']).parse(f.what)
    if (what === 'outreach') {
      if (!lead.contact_id) throw new Error('add a contact to this lead first')
      const c = (await db.from('brand_contacts').select('do_not_contact, opted_out_at').eq('id', lead.contact_id).single()).data
      if (c?.do_not_contact || c?.opted_out_at) throw new Error('this contact opted out')
    }
    const r = await queueAgentTask(db, process.env, what === 'score'
      ? { workspaceId: workspace.id, characterId: lead.character_id, role: 'sales', type: 'score_lead', title: `Score ${lead.brand_name}`, input: { leadId, brandName: lead.brand_name, ...(lead.notes ? { notes: lead.notes.slice(0, 4000) } : {}) }, userId: user.id, runNow: true }
      : { workspaceId: workspace.id, characterId: lead.character_id, role: 'sales', type: 'draft_outreach', title: `Outreach to ${lead.brand_name}`, input: { leadId, contactId: lead.contact_id!, ...(lead.notes ? { context: lead.notes.slice(0, 4000) } : {}) }, userId: user.id, runNow: true })
    return what === 'outreach' ? `${describeOutcome(r.outcome)} The draft is waiting in Approval Requests — nothing has been sent.` : describeOutcome(r.outcome)
  }, [...PATHS, '/agents/approvals'])
}

export async function addDeal(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace, user }) => {
    const f = z.object({ characterId: Id, leadId: optId, contactId: optId, title: z.string().trim().min(1).max(300), value: z.string().default('0'), currency: CUR, deliverables: z.string().max(4000).optional(), usageRights: z.string().max(2000).optional(), dueDate: DATE.optional() }).parse(formObject(fd))
    const ins = await db.from('brand_deals').insert({
      workspace_id: workspace.id, character_id: f.characterId, lead_id: f.leadId ?? null, contact_id: f.contactId ?? null, title: f.title, value_cents: parseAmountToCents(f.value), currency: f.currency,
      deliverables: (f.deliverables ? f.deliverables.split('\n').map(s => s.trim()).filter(Boolean) : []) as Json, usage_rights: f.usageRights ?? null, due_date: f.dueDate ?? null,
    })
    if (ins.error) throw new Error(ins.error.message)
    if (f.leadId) await db.from('leads').update({ stage: 'won', stage_changed_at: new Date().toISOString() }).eq('workspace_id', workspace.id).eq('id', f.leadId)
    await recordAudit({ workspaceId: workspace.id, actorType: 'user', actorId: user.id, action: 'monetisation.add_deal', details: { title: f.title } })
    return 'Deal added. Content for it is always marked sponsored with #ad.'
  }, PATHS)
}

export async function setDealStatus(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace, user }) => {
    const id = Id.parse(fd.get('id'))
    const status = z.enum(['negotiating', 'contracted', 'in_production', 'delivered', 'invoiced', 'paid', 'cancelled']).parse(fd.get('status'))
    const deal = (await db.from('brand_deals').select('*').eq('workspace_id', workspace.id).eq('id', id).single()).data
    if (!deal) throw new Error('deal not found')
    const now = new Date().toISOString()
    const r = await db.from('brand_deals').update({ status, ...(status === 'invoiced' ? { invoiced_at: now } : {}), ...(status === 'paid' ? { paid_at: now } : {}) }).eq('id', id)
    if (r.error) throw new Error(r.error.message)
    // Paying a deal records its revenue once.
    if (status === 'paid' && deal.value_cents > 0) {
      await db.from('revenue').upsert({ workspace_id: workspace.id, character_id: deal.character_id, source_type: 'sponsorship', brand_deal_id: deal.id, amount_cents: deal.value_cents, currency: deal.currency, occurred_on: now.slice(0, 10), status: 'received', external_ref: `deal:${deal.id}`, description: deal.title },
        { onConflict: 'workspace_id,source_type,external_ref', ignoreDuplicates: true })
    }
    await recordAudit({ workspaceId: workspace.id, actorType: 'user', actorId: user.id, action: 'monetisation.deal_status', entityType: 'brand_deal', entityId: id, details: { status } })
    return `Deal ${status.replace('_', ' ')}.`
  }, PATHS)
}

export async function addProduct(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace }) => {
    const f = z.object({ characterId: optId, name: z.string().trim().min(1).max(200), kind: z.enum(['digital', 'physical', 'service', 'membership']), price: z.string().optional(), currency: CUR, externalRef: z.string().max(200).optional() }).parse(formObject(fd))
    const ins = await db.from('products').insert({ workspace_id: workspace.id, character_id: f.characterId ?? null, name: f.name, kind: f.kind, price_cents: f.price ? parseAmountToCents(f.price) : null, currency: f.currency, external_ref: f.externalRef ?? null, status: 'active' })
    if (ins.error) throw new Error(ins.error.message)
    return 'Product added.'
  }, PATHS)
}

export async function addRevenue(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace, user }) => {
    const f = z.object({
      characterId: optId, sourceType: z.enum(['affiliate', 'sponsorship', 'product', 'subscription', 'tips', 'licensing', 'platform_payout', 'other']), amount: z.string(), currency: CUR,
      occurredOn: DATE, status: z.enum(['expected', 'pending', 'received']).default('received'), affiliateLinkId: optId, productId: optId, brandDealId: optId, description: z.string().max(500).optional(), externalRef: z.string().max(200).optional(),
    }).parse(formObject(fd))
    const ins = await db.from('revenue').insert({
      workspace_id: workspace.id, character_id: f.characterId ?? null, source_type: f.sourceType, amount_cents: parseAmountToCents(f.amount), currency: f.currency, occurred_on: f.occurredOn, status: f.status,
      affiliate_link_id: f.affiliateLinkId ?? null, product_id: f.productId ?? null, brand_deal_id: f.brandDealId ?? null, description: f.description ?? null, external_ref: f.externalRef ?? null,
    })
    if (ins.error) throw new Error(ins.error.code === '23505' ? 'a revenue entry with that reference already exists' : ins.error.message)
    await recordAudit({ workspaceId: workspace.id, actorType: 'user', actorId: user.id, action: 'finance.add_revenue', details: { source: f.sourceType, currency: f.currency } })
    return 'Revenue recorded.'
  }, PATHS)
}

export async function setRevenueStatus(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace }) => {
    const r = await db.from('revenue').update({ status: z.enum(['expected', 'pending', 'received', 'refunded']).parse(fd.get('status')) }).eq('workspace_id', workspace.id).eq('id', Id.parse(fd.get('id')))
    if (r.error) throw new Error(r.error.message)
  }, PATHS)
}

export async function addExpense(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace, user }) => {
    const f = z.object({ characterId: optId, category: z.enum(['ai_compute', 'software', 'ads', 'production', 'contractor', 'fees', 'other']), vendor: z.string().max(200).optional(), amount: z.string(), currency: CUR, occurredOn: DATE, description: z.string().max(500).optional() }).parse(formObject(fd))
    const ins = await db.from('expenses').insert({ workspace_id: workspace.id, character_id: f.characterId ?? null, category: f.category, vendor: f.vendor ?? null, amount_cents: parseAmountToCents(f.amount), currency: f.currency, occurred_on: f.occurredOn, description: f.description ?? null })
    if (ins.error) throw new Error(ins.error.message)
    await recordAudit({ workspaceId: workspace.id, actorType: 'user', actorId: user.id, action: 'finance.add_expense', details: { category: f.category } })
    return 'Expense recorded.'
  }, PATHS)
}

export async function financeReport(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace, user }) => {
    const characterId = Id.parse(fd.get('characterId'))
    const since = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10)
    const [{ data: rev }, { data: exp }] = await Promise.all([
      db.from('revenue').select('amount_cents, currency, status, source_type, character_id').eq('workspace_id', workspace.id).eq('character_id', characterId).gte('occurred_on', since),
      db.from('expenses').select('amount_cents, currency, category, character_id').eq('workspace_id', workspace.id).eq('character_id', characterId).gte('occurred_on', since),
    ])
    const ledger = { period: `${since} to today`, byCurrency: summarise(rev ?? [], exp ?? []) }
    const r = await queueAgentTask(db, process.env, { workspaceId: workspace.id, characterId, role: 'finance_analyst', type: 'finance_report', title: 'Finance report (90 days)', input: { ledger, periodDays: 90 }, userId: user.id, runNow: true })
    return describeOutcome(r.outcome)
  }, PATHS)
}
