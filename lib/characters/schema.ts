import { z } from 'zod'

/**
 * Validation for character identity (wizard + profile editors). The same
 * schemas guard server actions, so the database only ever receives
 * well-formed, bounded input. jsonb shapes here mirror the columns in
 * supabase/migrations/20260924000100_character_identity.sql.
 */

const text = (max: number) => z.string().trim().max(max)
const optionalText = (max: number) => text(max).optional().transform(v => (v ? v : undefined))
const list = (itemMax: number, count: number) => z.array(z.string().trim().min(1).max(itemMax)).max(count).default([])

export const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/

export function slugify(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'character'
}

export const Personality = z.object({
  traits: list(60, 20),
  values: list(80, 10),
  quirks: list(120, 10),
  humor: optionalText(200),
}).strict()

export const ContentBoundaries = z.object({
  avoidTopics: list(80, 50),
  sensitiveTopicsNeedReview: list(80, 50),
  neverSay: list(200, 50),
}).strict()

export const PlatformStrategy = z.object({
  platforms: z.array(z.object({
    platform: z.enum(['instagram', 'tiktok', 'youtube', 'x']),
    goal: optionalText(300),
    postsPerWeek: z.number().int().min(0).max(50).optional(),
    formats: list(30, 10),
  }).strict()).max(10).default([]),
}).strict()

export const MonetisationStrategy = z.object({
  channels: z.array(z.enum(['affiliate', 'sponsorship', 'product', 'subscription', 'tips', 'licensing'])).max(6).default([]),
  notes: optionalText(2000),
  noGoCategories: list(80, 30),
}).strict()

export const CharacterBasics = z.object({
  name: text(120).min(1),
  slug: z.string().regex(SLUG).max(80).optional(),
  displayName: text(80).min(1),
  description: optionalText(2000),
  niche: optionalText(120),
  targetAudience: optionalText(1000),
  language: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).default('en'),
}).strict()

export const CharacterVoice = z.object({
  personality: Personality,
  toneOfVoice: optionalText(1000),
  backstory: optionalText(5000),
}).strict()

export const VisualIdentity = z.object({
  appearanceDescription: optionalText(4000),
  styleKeywords: list(60, 50),
  colorPalette: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(20).default([]),
  cameraStyle: optionalText(500),
  promptPrefix: optionalText(2000),
  negativePrompt: optionalText(2000),
  doNotDepict: list(120, 50),
}).strict()

export const BrandRule = z.object({
  ruleType: z.enum(['do', 'dont', 'voice', 'topic_allowed', 'topic_blocked', 'hashtag', 'cta', 'brand_safety']),
  rule: text(500).min(1),
  priority: z.number().int().min(1).max(5).default(3),
})

export const SafetySettings = z.object({
  aiDisclosureMode: z.enum(['always', 'bio_and_posts', 'bio_only']).default('always'),
  disclosureText: text(200).min(3).default('AI-generated virtual character'),
  approvalMode: z.enum(['human_required', 'auto_low_risk']).default('human_required'),
  minAudienceAge: z.number().int().min(13).max(21).default(13),
  ageRestricted: z.boolean().default(false),
  depictsRealPerson: z.boolean().default(false),
  consentEvidencePath: optionalText(500),
}).strict().superRefine((v, ctx) => {
  if (v.ageRestricted && v.minAudienceAge < 18) ctx.addIssue({ code: 'custom', path: ['minAudienceAge'], message: 'Age-restricted characters must target 18+.' })
  if (v.depictsRealPerson && !v.consentEvidencePath) ctx.addIssue({ code: 'custom', path: ['consentEvidencePath'], message: 'A real-person likeness requires uploaded consent evidence.' })
})

/** Full wizard payload. */
export const CreateCharacterInput = z.object({
  basics: CharacterBasics,
  voice: CharacterVoice,
  visual: VisualIdentity,
  brandRules: z.array(BrandRule).max(100).default([]),
  boundaries: ContentBoundaries,
  platformStrategy: PlatformStrategy,
  monetisationStrategy: MonetisationStrategy,
  safety: SafetySettings,
}).strict()

export type CreateCharacterInput = z.infer<typeof CreateCharacterInput>

export const MemoryInput = z.object({
  kind: z.enum(['fact', 'preference', 'event', 'relationship', 'catchphrase', 'continuity']),
  content: text(2000).min(1),
  importance: z.number().int().min(1).max(5).default(3),
})
