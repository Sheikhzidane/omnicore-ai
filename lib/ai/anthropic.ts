import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { ProviderError, ProviderRefusalError, retryableStatus } from './errors'
import { jsonSchemaFor, parseStructured } from './json'
import { costUsd } from './pricing'
import type { ModerationProvider, TextProvider, TextRequest, TextResult, Usage } from './types'

/**
 * Claude adapter (official SDK). Defaults: `claude-opus-5` for capable work,
 * `claude-haiku-4-5` for fast/cheap classification; both overridable with
 * ANTHROPIC_MODEL / ANTHROPIC_FAST_MODEL.
 *
 * - Structured output via output_config.format (JSON schema from zod), then
 *   re-validated with zod before anything is stored.
 * - The character system prompt is cached (cache_control) — it's stable per
 *   character, so repeated agent runs read it from cache.
 * - Server-side refusal fallbacks are enabled for Opus-family models; a final
 *   refusal becomes ProviderRefusalError (surfaced to a human, not retried).
 */

const DEFAULT_MODEL = 'claude-opus-5'
const DEFAULT_FAST_MODEL = 'claude-haiku-4-5'
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

export function anthropicConfigured(env: Record<string, string | undefined>): boolean {
  return !!env.ANTHROPIC_API_KEY
}

function supportsFallbacks(model: string): boolean {
  return /^claude-(opus-5|fable-5)/.test(model)
}

function toUsage(u: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): Usage {
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  }
}

function mapError(e: unknown): never {
  if (e instanceof Anthropic.APIError) {
    throw new ProviderError(`anthropic: ${e.message}`, retryableStatus(e.status), e.status)
  }
  throw new ProviderError(`anthropic: ${(e as Error).message}`, true)
}

export function createAnthropicTextProvider(env: Record<string, string | undefined>): TextProvider {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2 })
  const models = { capable: env.ANTHROPIC_MODEL || DEFAULT_MODEL, fast: env.ANTHROPIC_FAST_MODEL || DEFAULT_FAST_MODEL }

  return {
    id: 'anthropic',
    async generate<T>(req: TextRequest<T>): Promise<TextResult<T>> {
      const model = models[req.tier ?? 'capable']
      let response: Anthropic.Beta.Messages.BetaMessage
      try {
        response = await client.beta.messages.create({
          model,
          max_tokens: req.maxTokens ?? 16000,
          system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: req.prompt }],
          ...(req.schema ? { output_config: { format: { type: 'json_schema', schema: jsonSchemaFor(req.schema) } } } : {}),
          ...(supportsFallbacks(model) ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
        })
      } catch (e) {
        mapError(e)
      }
      if (response.stop_reason === 'refusal') {
        throw new ProviderRefusalError('anthropic', response.stop_details?.category ?? undefined)
      }
      const text = response.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('')
      const usage = toUsage(response.usage)
      return {
        provider: 'anthropic',
        model: response.model,
        text,
        data: req.schema ? parseStructured(text, req.schema) : undefined,
        usage,
        costUsd: costUsd(model, usage),
      }
    },
  }
}

const ModerationSchema = z.object({
  flagged: z.boolean(),
  categories: z.array(z.enum([
    'sexual', 'sexual_minors', 'hate', 'harassment', 'violence', 'self_harm', 'illicit',
    'impersonation', 'deception', 'medical_claims', 'financial_claims', 'spam',
  ])),
})

/** LLM-based moderation (fast tier). Used when no dedicated moderation API is configured. */
export function createAnthropicModerationProvider(env: Record<string, string | undefined>): ModerationProvider {
  const text = createAnthropicTextProvider(env)
  return {
    id: 'anthropic',
    async moderate(input: string) {
      const res = await text.generate({
        tier: 'fast',
        maxTokens: 512,
        schema: ModerationSchema,
        system: 'You are a content-safety classifier for social media posts by an AI virtual character. Flag content that is sexual, involves minors in any sexual context, hateful, harassing, violent, promotes self-harm or illegal activity, impersonates a real person, deceives the audience (e.g. claims to be human), makes unsupported medical/financial claims, or is spam. Return only the JSON object.',
        prompt: `Classify this content:\n\n<content>\n${input}\n</content>`,
      })
      return { provider: 'anthropic', flagged: res.data!.flagged, categories: res.data!.categories }
    },
  }
}
