import type { CharacterRow, PublishingPolicyRow } from '@/types/database'

/**
 * The publish gate. Decides whether an item may be published, and whether a
 * human must approve it first. Default: human approval. Automatic publishing
 * is possible only when EVERY condition below holds.
 */

export type SafetyStatus = 'unchecked' | 'passed' | 'flagged' | 'blocked'

export interface PublishContext {
  character: Pick<CharacterRow, 'approval_mode' | 'status'>
  policy: Pick<PublishingPolicyRow,
    'publishing_enabled' | 'requires_human_approval' | 'max_posts_per_day' | 'min_minutes_between_posts'>
  safetyStatus: SafetyStatus
  disclosureMissing: string[]
  isSponsored: boolean
  accountConnected: boolean
  postsInLast24h: number
  lastPostAt: Date | null
  now: Date
}

export interface PublishDecision {
  /** Can this item be published at all right now (after any approval)? */
  allowed: boolean
  /** Must a human approve before publishing? */
  requiresHumanApproval: boolean
  reasons: string[]
}

export function decidePublish(ctx: PublishContext): PublishDecision {
  const blockers: string[] = []
  if (!ctx.accountConnected) blockers.push('Social account is not connected.')
  if (!ctx.policy.publishing_enabled) blockers.push('Publishing is disabled for this platform.')
  if (ctx.character.status !== 'active') blockers.push('Character is not active.')
  if (ctx.safetyStatus === 'blocked') blockers.push('Content was blocked by the safety check.')
  if (ctx.safetyStatus === 'unchecked') blockers.push('Content has not passed the safety check.')
  if (ctx.disclosureMissing.length) blockers.push(`Missing disclosure: ${ctx.disclosureMissing.join(', ')}.`)
  if (ctx.postsInLast24h >= ctx.policy.max_posts_per_day) blockers.push('Daily posting limit reached.')
  if (ctx.lastPostAt) {
    const minutes = (ctx.now.getTime() - ctx.lastPostAt.getTime()) / 60_000
    if (minutes < ctx.policy.min_minutes_between_posts) blockers.push('Minimum interval between posts not yet elapsed.')
  }

  const humanReasons: string[] = []
  if (ctx.character.approval_mode === 'human_required') humanReasons.push('Character requires human approval.')
  if (ctx.policy.requires_human_approval) humanReasons.push('Platform policy requires human approval.')
  if (ctx.safetyStatus === 'flagged') humanReasons.push('Safety check flagged this content for review.')
  if (ctx.isSponsored) humanReasons.push('Sponsored content always requires human approval.')

  return {
    allowed: blockers.length === 0,
    requiresHumanApproval: humanReasons.length > 0,
    reasons: [...blockers, ...humanReasons],
  }
}
