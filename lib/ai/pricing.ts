import type { Usage } from './types'

/**
 * USD per 1M tokens for cost tracking (agent budgets, ai_compute expenses).
 * Figures are Anthropic first-party list prices at time of writing; unknown
 * models record cost 0 and are flagged in the run metadata. Update when
 * prices change — they only affect budgeting, never billing.
 */
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-5':     { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5':   { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-4-5':  { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
}

export function knownPrice(model: string): boolean {
  return model in PRICES
}

export function costUsd(model: string, u: Usage): number {
  const p = PRICES[model]
  if (!p) return 0
  const cost = (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadTokens * p.cacheRead + u.cacheWriteTokens * p.cacheWrite) / 1_000_000
  return Math.round(cost * 1e6) / 1e6
}
