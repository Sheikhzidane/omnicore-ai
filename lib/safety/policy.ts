import { z } from 'zod'

/**
 * Content policy rules (stored in content_policies.rules, validated here on
 * every write). Owners can ADD restrictions; the HARD_BLOCKED categories can
 * never be removed or overridden.
 */

export const HARD_BLOCKED_CATEGORIES = [
  'sexual_content_involving_minors',
  'sexualised_depiction_of_minor_looking_characters',
  'non_consensual_intimate_imagery',
  'real_person_likeness_without_consent',
  'impersonation_of_real_people',
  'incitement_to_violence',
  'hate_speech',
  'self_harm_promotion',
] as const

export const ContentPolicyRules = z.object({
  /** Extra topics this workspace/character must not produce. */
  blockedTopics: z.array(z.string().trim().min(2).max(80)).max(100).default([]),
  /** Words that trigger human review (brand safety). */
  reviewTerms: z.array(z.string().trim().min(2).max(80)).max(200).default([]),
  /** Health/finance/legal claims must carry a disclaimer. */
  requireDisclaimerFor: z.array(z.enum(['health', 'finance', 'legal'])).default(['health', 'finance', 'legal']),
  /** Content rating ceiling. 'mature' additionally requires an age-restricted character. */
  maxRating: z.enum(['general', 'teen', 'mature']).default('general'),
  /** Hard-blocked categories are always included and cannot be removed. */
  hardBlocked: z.array(z.string()).optional(),
}).strict()

export type ContentPolicyRules = z.infer<typeof ContentPolicyRules>

export function parsePolicy(input: unknown): ContentPolicyRules {
  const rules = ContentPolicyRules.parse(input ?? {})
  return { ...rules, hardBlocked: [...HARD_BLOCKED_CATEGORIES] }
}

export const DEFAULT_POLICY: ContentPolicyRules = parsePolicy({})
