import type { CharacterRow } from '@/types/database'

export type ContentRating = 'general' | 'teen' | 'mature'

type AudienceCharacter = Pick<CharacterRow, 'age_restricted' | 'min_audience_age'>

/**
 * Age-gating: mature content only for age-restricted (18+) characters, and
 * only where the destination platform/account supports audience restriction.
 */
export function checkAudience(
  character: AudienceCharacter,
  rating: ContentRating,
  platformSupportsAgeRestriction: boolean,
): { allowed: boolean; reason?: string } {
  if (rating !== 'mature') return { allowed: true }
  if (!character.age_restricted || character.min_audience_age < 18) {
    return { allowed: false, reason: 'Mature content requires an age-restricted (18+) character.' }
  }
  if (!platformSupportsAgeRestriction) {
    return { allowed: false, reason: 'The destination cannot restrict this content to adults.' }
  }
  return { allowed: true }
}
