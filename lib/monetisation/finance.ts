/**
 * Money maths in integer minor units (cents), per currency — amounts in
 * different currencies are never added together (no invented FX rates).
 */

export interface Money { currency: string; cents: number }

export interface RevenueEntry { amount_cents: number; currency: string; status: 'expected' | 'pending' | 'received' | 'refunded'; source_type: string; character_id: string | null }
export interface ExpenseEntry { amount_cents: number; currency: string; category: string; character_id: string | null }

export interface CurrencySummary {
  currency: string
  receivedCents: number
  pendingCents: number
  expectedCents: number
  refundedCents: number
  expenseCents: number
  profitCents: number
  /** (received − expenses) ÷ expenses. Null when there are no expenses. */
  roi: number | null
  bySource: Record<string, number>
  byExpenseCategory: Record<string, number>
}

export function summarise(revenue: RevenueEntry[], expenses: ExpenseEntry[]): CurrencySummary[] {
  const map = new Map<string, CurrencySummary>()
  const get = (c: string) => {
    const k = c.toUpperCase()
    if (!map.has(k)) map.set(k, { currency: k, receivedCents: 0, pendingCents: 0, expectedCents: 0, refundedCents: 0, expenseCents: 0, profitCents: 0, roi: null, bySource: {}, byExpenseCategory: {} })
    return map.get(k)!
  }
  for (const r of revenue) {
    const s = get(r.currency)
    if (r.status === 'received') { s.receivedCents += r.amount_cents; s.bySource[r.source_type] = (s.bySource[r.source_type] ?? 0) + r.amount_cents }
    else if (r.status === 'pending') s.pendingCents += r.amount_cents
    else if (r.status === 'expected') s.expectedCents += r.amount_cents
    else s.refundedCents += r.amount_cents
  }
  for (const e of expenses) {
    const s = get(e.currency)
    s.expenseCents += e.amount_cents
    s.byExpenseCategory[e.category] = (s.byExpenseCategory[e.category] ?? 0) + e.amount_cents
  }
  for (const s of map.values()) {
    s.profitCents = s.receivedCents - s.expenseCents
    s.roi = s.expenseCents > 0 ? s.profitCents / s.expenseCents : null
  }
  return [...map.values()].sort((a, b) => a.currency.localeCompare(b.currency))
}

export function formatMoney(cents: number, currency: string, locale = 'en-GB') {
  try { return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100) } catch { return `${(cents / 100).toFixed(2)} ${currency}` }
}

/** Parses "12.34" into 1234 cents without floating-point drift. */
export function parseAmountToCents(input: string): number {
  const m = /^\s*(\d{1,12})(?:[.,](\d{1,2}))?\s*$/.exec(input)
  if (!m) throw new Error('enter an amount like 120 or 120.50')
  return Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0'))
}
