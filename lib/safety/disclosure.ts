import type { CharacterRow, PublishingPolicyRow } from '@/types/database'

/**
 * AI-character and sponsorship disclosure. Applied to every post before it can
 * be approved; the database also forbids turning either off.
 */

export const SPONSORED_TAG = '#ad'

type CharacterDisclosure = Pick<CharacterRow, 'ai_disclosure_mode' | 'disclosure_text'>
type PlatformDisclosure = Pick<PublishingPolicyRow, 'ai_label_required'>

export interface DisclosureInput {
  caption: string
  character: CharacterDisclosure
  platform: PlatformDisclosure
  isSponsored: boolean
}

function postNeedsAiLabel(character: CharacterDisclosure, platform: PlatformDisclosure): boolean {
  // 'bio_only' still gets a post label when the platform policy requires one.
  return character.ai_disclosure_mode !== 'bio_only' || platform.ai_label_required
}

/** Returns the caption with required disclosures appended (idempotent). */
export function applyDisclosure({ caption, character, platform, isSponsored }: DisclosureInput): string {
  let out = caption.trim()
  const lower = out.toLowerCase()
  if (isSponsored && !/(^|\s)#(ad|sponsored)\b/i.test(out)) {
    out = `${out}\n\n${SPONSORED_TAG}`
  }
  if (postNeedsAiLabel(character, platform) && !lower.includes(character.disclosure_text.toLowerCase())) {
    out = `${out}\n\n${character.disclosure_text}`
  }
  return out
}

/** Lists missing disclosures; empty means the caption is compliant. */
export function missingDisclosures({ caption, character, platform, isSponsored }: DisclosureInput): string[] {
  const missing: string[] = []
  if (isSponsored && !/(^|\s)#(ad|sponsored)\b/i.test(caption)) missing.push('sponsorship')
  if (postNeedsAiLabel(character, platform) && !caption.toLowerCase().includes(character.disclosure_text.toLowerCase())) {
    missing.push('ai_character')
  }
  return missing
}
