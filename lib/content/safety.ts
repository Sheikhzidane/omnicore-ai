import type { ContentPolicyRules } from '@/lib/safety/policy'
import { HARD_BLOCKED_CATEGORIES } from '@/lib/safety/policy'
import { checkAudience, type ContentRating } from '@/lib/safety/audience'
import type { ModerationResult } from '@/lib/ai/types'

/**
 * Pre-publication content assessment. Deterministic rules first, then the
 * moderation provider's verdict. Outcomes:
 *   blocked — must be edited; no human can override
 *   flagged — a human must review and explicitly clear it before approval
 *   passed  — eligible for the approval step
 * If no moderation provider is configured the content is FLAGGED (human
 * review replaces automated moderation) — never silently passed.
 */

export interface AssessInput {
  text: string
  rating: ContentRating
  character: { age_restricted: boolean; min_audience_age: number }
  platformSupportsAgeRestriction: boolean
  policy: ContentPolicyRules
  blockedTopics: string[]
  moderation: ModerationResult | null
}

export interface Assessment {
  status: 'passed' | 'flagged' | 'blocked'
  reasons: string[]
  categories: string[]
  moderation: 'checked' | 'unavailable'
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const mentions = (text: string, term: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${escape(term)}([^\\p{L}\\p{N}]|$)`, 'iu').test(text)

/** An AI character must never claim to be a real human. */
const HUMAN_CLAIMS = [
  /\b(i\s*'?\s*a?m|i am)\s+(a\s+)?(real|actual)\s+(person|human|girl|guy|woman|man)\b/i,
  /\b(i\s*'?\s*a?m|i am)\s+not\s+(an?\s+)?(ai|bot|robot|virtual)\b/i,
  /\bthis\s+is\s+(really\s+)?me\s+personally\s+(typing|replying|writing)\b/i,
]

const CLAIM_TOPICS: Record<'health' | 'finance' | 'legal', { terms: RegExp; disclaimer: RegExp }> = {
  health: { terms: /\b(cure[sd]?|treat(s|ment)?|diagnos\w*|supplement|weight\s*loss|detox|medication|dosage)\b/i, disclaimer: /not\s+(medical|health)\s+advice|consult\s+(a|your)\s+(doctor|physician|healthcare)/i },
  finance: { terms: /\b(invest(ing|ment)?|crypto|stocks?|returns?|passive\s+income|trading|forex|guaranteed\s+profit)\b/i, disclaimer: /not\s+financial\s+advice|do\s+your\s+own\s+research/i },
  legal: { terms: /\b(lawsuit|legal\s+advice|sue|contract\s+law|immigration\s+law)\b/i, disclaimer: /not\s+legal\s+advice|consult\s+(a|an)\s+(lawyer|attorney)/i },
}

export function claimsToBeHuman(text: string): boolean {
  return HUMAN_CLAIMS.some(re => re.test(text))
}

export function assessContent(i: AssessInput): Assessment {
  const blocked: string[] = [], flagged: string[] = [], categories = new Set<string>()
  const text = i.text

  if (!text.trim()) blocked.push('Content is empty.')
  if (claimsToBeHuman(text)) { blocked.push('Claims the AI character is a real human.'); categories.add('deceptive_human_claim') }

  const aud = checkAudience(i.character, i.rating, i.platformSupportsAgeRestriction)
  if (!aud.allowed) blocked.push(aud.reason!)
  const ceiling: ContentRating[] = ['general', 'teen', 'mature']
  if (ceiling.indexOf(i.rating) > ceiling.indexOf(i.policy.maxRating)) blocked.push(`Rating "${i.rating}" exceeds the policy maximum "${i.policy.maxRating}".`)

  for (const t of [...i.policy.blockedTopics, ...i.blockedTopics]) if (mentions(text, t)) { blocked.push(`Mentions blocked topic "${t}".`); categories.add('blocked_topic') }
  for (const t of i.policy.reviewTerms) if (mentions(text, t)) { flagged.push(`Mentions review term "${t}".`); categories.add('review_term') }

  for (const topic of i.policy.requireDisclaimerFor) {
    const c = CLAIM_TOPICS[topic]
    if (c.terms.test(text) && !c.disclaimer.test(text)) { flagged.push(`Possible ${topic} claim without a disclaimer.`); categories.add(`${topic}_claim`) }
  }

  if (!i.moderation) {
    flagged.push('Automated moderation is not configured — a human must review this content.')
  } else if (i.moderation.flagged) {
    const hard = i.moderation.categories.filter(c => (HARD_BLOCKED_CATEGORIES as readonly string[]).includes(c) || /minor|csam|sexual\/minors|self-harm\/instructions|violence\/graphic|hate\/threatening/i.test(c))
    i.moderation.categories.forEach(c => categories.add(c))
    if (hard.length) blocked.push(`Moderation blocked: ${hard.join(', ')}.`)
    else flagged.push(`Moderation flagged: ${i.moderation.categories.join(', ') || 'unspecified'}.`)
  }

  const status = blocked.length ? 'blocked' : flagged.length ? 'flagged' : 'passed'
  return { status, reasons: [...blocked, ...flagged], categories: [...categories].sort(), moderation: i.moderation ? 'checked' : 'unavailable' }
}
