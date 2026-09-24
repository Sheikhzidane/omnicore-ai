/**
 * Character identity → a deterministic, cacheable system prompt.
 *
 * Every agent that writes as or about a character gets the SAME identity
 * block, built from the profile, visual rules, active brand rules and CANON
 * memories only (agent-proposed memories are excluded until a human confirms
 * them). Output is stable for identical input (sorted, no timestamps), so the
 * provider can serve it from prompt cache across runs.
 */

export interface CharacterIdentity {
  character: {
    id: string
    name: string
    status: string
    ai_disclosure_mode: string
    disclosure_text: string
    min_audience_age: number
    age_restricted: boolean
  }
  profile: {
    display_name: string
    description: string | null
    niche: string | null
    target_audience: string | null
    personality: unknown
    tone_of_voice: string | null
    backstory: string | null
    content_boundaries: unknown
    language: string
  } | null
  visual: {
    appearance_description: string | null
    style_keywords: string[]
    color_palette: string[]
    camera_style: string | null
    prompt_prefix: string | null
    negative_prompt: string | null
    do_not_depict: string[]
  } | null
  brandRules: { rule_type: string; rule: string; priority: number; active: boolean }[]
  memories: { kind: string; content: string; importance: number; is_canon: boolean }[]
}

const stable = (v: unknown) => JSON.stringify(v, Object.keys((v ?? {}) as object).sort())

export const NON_NEGOTIABLE_RULES = [
  'You are writing for a fictional AI virtual character. Never claim or imply the character is a real human, and never deny being AI if asked.',
  'Never impersonate, speak as, or claim endorsement from a real person or brand.',
  'Sponsored or affiliate content must be clearly disclosed.',
  'Never produce sexual content involving minors or minor-looking characters, hate, harassment, or encouragement of self-harm or illegal activity.',
  'Do not make unsupported medical, legal or financial claims.',
  'Do not write spam, engagement bait that deceives, or messages to people who did not contact the character.',
]

export function buildCharacterSystemPrompt(id: CharacterIdentity): string {
  const p = id.profile
  const lines: string[] = []
  lines.push(`# Character: ${p?.display_name ?? id.character.name}`)
  lines.push(`AI disclosure (always applies): "${id.character.disclosure_text}" — mode: ${id.character.ai_disclosure_mode}.`)
  lines.push(`Audience: ${id.character.age_restricted ? `adults only (${id.character.min_audience_age}+)` : `general (${id.character.min_audience_age}+) — keep content suitable`}.`)
  if (p) {
    if (p.niche) lines.push(`Niche: ${p.niche}`)
    if (p.description) lines.push(`Description: ${p.description}`)
    if (p.target_audience) lines.push(`Target audience: ${p.target_audience}`)
    if (p.tone_of_voice) lines.push(`Tone of voice: ${p.tone_of_voice}`)
    lines.push(`Personality: ${stable(p.personality)}`)
    if (p.backstory) lines.push(`Backstory: ${p.backstory}`)
    lines.push(`Content boundaries: ${stable(p.content_boundaries)}`)
    lines.push(`Language: ${p.language}`)
  }
  if (id.visual) {
    const v = id.visual
    lines.push('## Visual identity')
    if (v.appearance_description) lines.push(`Appearance: ${v.appearance_description}`)
    if (v.style_keywords.length) lines.push(`Style: ${[...v.style_keywords].sort().join(', ')}`)
    if (v.color_palette.length) lines.push(`Palette: ${v.color_palette.join(', ')}`)
    if (v.camera_style) lines.push(`Camera: ${v.camera_style}`)
    if (v.do_not_depict.length) lines.push(`Never depict: ${[...v.do_not_depict].sort().join(', ')}`)
  }
  const rules = id.brandRules.filter(r => r.active).sort((a, b) => b.priority - a.priority || a.rule_type.localeCompare(b.rule_type) || a.rule.localeCompare(b.rule))
  if (rules.length) {
    lines.push('## Brand rules')
    for (const r of rules) lines.push(`- [${r.rule_type}] ${r.rule}`)
  }
  const canon = id.memories.filter(m => m.is_canon).sort((a, b) => b.importance - a.importance || a.content.localeCompare(b.content)).slice(0, 50)
  if (canon.length) {
    lines.push('## Canon (stay consistent with these)')
    for (const m of canon) lines.push(`- (${m.kind}) ${m.content}`)
  }
  lines.push('## Non-negotiable rules')
  for (const r of NON_NEGOTIABLE_RULES) lines.push(`- ${r}`)
  return lines.join('\n')
}

/** Visual prompt prefix for image/video generation, enforcing do-not-depict. */
export function visualPromptParts(id: CharacterIdentity): { prefix: string; negative: string } {
  const v = id.visual
  const negative = [v?.negative_prompt, ...(v?.do_not_depict ?? []), 'real identifiable people', 'minors in any suggestive context']
    .filter(Boolean).join(', ')
  const prefix = [v?.prompt_prefix, v?.appearance_description, v?.style_keywords.length ? `style: ${v.style_keywords.join(', ')}` : null]
    .filter(Boolean).join('. ')
  return { prefix, negative }
}
