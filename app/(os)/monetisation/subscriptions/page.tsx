import { createClient } from '@/lib/supabase/server'
import { integrationState } from '@/lib/config/integrations'
import { formatMoney } from '@/lib/monetisation/finance'
import { PageHeader, Panel } from '@/components/shell/page-header'
import { DataTable, NotConfigured } from '@/components/ui/table'

export const dynamic = 'force-dynamic'

export default async function SubscriptionsPage() {
  const supabase = await createClient()
  const { data } = await supabase.from('revenue').select('*').eq('source_type', 'subscription').order('occurred_on', { ascending: false }).limit(200)
  const stripe = integrationState('stripe', process.env)
  const site = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, '') ?? ''
  return (
    <>
      <PageHeader title="Subscriptions" description="Paid subscription invoices recorded from verified Stripe events." />
      {stripe.status !== 'configured' ? <div className="mb-4"><NotConfigured what="Stripe" missing={stripe.missing}>Subscriptions can still be recorded manually in Revenue.</NotConfigured></div> : (
        <Panel title="Stripe webhook" className="mb-4">
          <p className="text-xs text-slate-400">Endpoint: <code>{site}/api/webhooks/stripe</code> · events: <code>invoice.paid</code>, <code>checkout.session.completed</code>, <code>charge.refunded</code>. Set <code>omnicore_workspace_id</code> (and optionally <code>omnicore_character_id</code>, <code>omnicore_product_id</code>) in the subscription/payment-link metadata so revenue is attributed.</p>
        </Panel>
      )}
      <DataTable rows={data ?? []} empty="No subscription revenue recorded." columns={[
        { key: 'd', label: 'Date', render: r => r.occurred_on },
        { key: 'a', label: 'Amount', render: r => formatMoney(r.amount_cents, r.currency) },
        { key: 's', label: 'Status', render: r => r.status },
        { key: 'x', label: 'Reference', render: r => <span className="text-xs text-slate-500">{r.external_ref ?? 'manual'}</span> },
      ]} />
    </>
  )
}
