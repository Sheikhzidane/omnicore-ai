import 'server-only'
import { ProviderNotConfiguredError } from './errors'
import { anthropicConfigured, createAnthropicModerationProvider, createAnthropicTextProvider } from './anthropic'
import {
  createOpenAIEmbeddingProvider, createOpenAIImageProvider, createOpenAIModerationProvider,
  createOpenAITextProvider, createOpenAIVideoProvider, openaiConfigured,
} from './openai'
import { createMockTextProvider, mockImageProvider, mockModerationProvider, mockVideoProvider } from './mock'
import type { EmbeddingProvider, ImageProvider, ModerationProvider, TextProvider, VideoProvider } from './types'

/**
 * Chooses AI providers from server env. Selection:
 *   AI_TEXT_PROVIDER       anthropic | openai        (default: first configured, Anthropic preferred)
 *   AI_IMAGE_PROVIDER      openai | none             (default: openai if OPENAI_API_KEY)
 *   AI_VIDEO_PROVIDER      openai | none             (default: none — opt in explicitly)
 *   AI_MODERATION_PROVIDER openai | anthropic | none (default: openai, else anthropic)
 *   AI_EMBEDDING_PROVIDER  openai | none
 * AI_PROVIDER_MODE=mock swaps in labelled mocks — refused in production.
 * Missing configuration throws ProviderNotConfiguredError; callers show
 * "NOT CONFIGURED" instead of pretending.
 */

type Env = Record<string, string | undefined>

export function mockMode(env: Env): boolean {
  if (env.AI_PROVIDER_MODE !== 'mock') return false
  if (env.NODE_ENV === 'production') {
    throw new Error('AI_PROVIDER_MODE=mock is not allowed in production builds')
  }
  return true
}

export function getTextProvider(env: Env = process.env): TextProvider {
  if (mockMode(env)) return createMockTextProvider()
  const choice = env.AI_TEXT_PROVIDER || (anthropicConfigured(env) ? 'anthropic' : openaiConfigured(env) ? 'openai' : '')
  if (choice === 'anthropic' && anthropicConfigured(env)) return createAnthropicTextProvider(env)
  if (choice === 'openai' && openaiConfigured(env)) return createOpenAITextProvider(env)
  throw new ProviderNotConfiguredError('text generation', choice === 'openai' ? ['OPENAI_API_KEY'] : ['ANTHROPIC_API_KEY'])
}

export function getImageProvider(env: Env = process.env): ImageProvider {
  if (mockMode(env)) return mockImageProvider
  const choice = env.AI_IMAGE_PROVIDER || (openaiConfigured(env) ? 'openai' : 'none')
  if (choice === 'openai' && openaiConfigured(env)) return createOpenAIImageProvider(env)
  throw new ProviderNotConfiguredError('image generation', ['AI_IMAGE_PROVIDER', 'OPENAI_API_KEY'])
}

export function getVideoProvider(env: Env = process.env): VideoProvider {
  if (mockMode(env)) return mockVideoProvider
  if (env.AI_VIDEO_PROVIDER === 'openai' && openaiConfigured(env)) return createOpenAIVideoProvider(env)
  throw new ProviderNotConfiguredError('video generation', ['AI_VIDEO_PROVIDER', 'OPENAI_API_KEY'])
}

/** Returns null when no moderation provider is configured (human review then required). */
export function getModerationProvider(env: Env = process.env): ModerationProvider | null {
  if (mockMode(env)) return mockModerationProvider
  const choice = env.AI_MODERATION_PROVIDER || (openaiConfigured(env) ? 'openai' : anthropicConfigured(env) ? 'anthropic' : 'none')
  if (choice === 'openai' && openaiConfigured(env)) return createOpenAIModerationProvider(env)
  if (choice === 'anthropic' && anthropicConfigured(env)) return createAnthropicModerationProvider(env)
  return null
}

export function getEmbeddingProvider(env: Env = process.env): EmbeddingProvider | null {
  if ((env.AI_EMBEDDING_PROVIDER || 'openai') === 'openai' && openaiConfigured(env)) return createOpenAIEmbeddingProvider(env)
  return null
}

/** Presence-only summary for Settings → AI Providers (never exposes values). */
export function aiProviderSummary(env: Env = process.env) {
  const safe = <T>(fn: () => T): T | null => { try { return fn() } catch { return null } }
  return {
    mock: env.AI_PROVIDER_MODE === 'mock',
    text: safe(() => getTextProvider(env))?.id ?? null,
    image: safe(() => getImageProvider(env))?.id ?? null,
    video: safe(() => getVideoProvider(env))?.id ?? null,
    moderation: safe(() => getModerationProvider(env))?.id ?? null,
    embeddings: getEmbeddingProvider(env)?.id ?? null,
  }
}
