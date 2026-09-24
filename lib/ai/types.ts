import type { z } from 'zod'

/**
 * Provider-neutral AI interfaces. Concrete adapters live next to this file
 * (anthropic.ts, openai.ts, mock.ts); lib/ai/registry.ts picks one from the
 * environment. Every adapter reports token usage and cost where the provider
 * exposes it, so agent runs can be budgeted and recorded in agent_runs.
 */

export type ModelTier = 'capable' | 'fast'

export interface Usage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface TextRequest<T> {
  /** Stable, cacheable system prompt (character identity + rules). */
  system: string
  /** Per-task instruction. */
  prompt: string
  /** When set, the model must return JSON matching this schema (validated). */
  schema?: z.ZodType<T>
  tier?: ModelTier
  maxTokens?: number
}

export interface TextResult<T> {
  provider: string
  model: string
  text: string
  /** Parsed and schema-validated output when a schema was requested. */
  data: T | undefined
  usage: Usage
  costUsd: number
}

export interface TextProvider {
  id: string
  generate<T = unknown>(req: TextRequest<T>): Promise<TextResult<T>>
}

export interface ImageRequest { prompt: string; negativePrompt?: string; size?: '1024x1024' | '1024x1536' | '1536x1024'; count?: number }
export interface GeneratedImage { mimeType: string; base64: string }
export interface ImageProvider {
  id: string
  generate(req: ImageRequest): Promise<{ provider: string; model: string; images: GeneratedImage[]; costUsd: number | null }>
}

export interface VideoRequest { prompt: string; seconds?: number; size?: string }
export type VideoJobStatus = 'queued' | 'in_progress' | 'completed' | 'failed'
export interface VideoProvider {
  id: string
  /** Video generation is asynchronous: start a job, then poll it. */
  start(req: VideoRequest): Promise<{ jobId: string; status: VideoJobStatus }>
  status(jobId: string): Promise<{ status: VideoJobStatus; error?: string }>
  download(jobId: string): Promise<{ mimeType: string; bytes: ArrayBuffer }>
}

export interface ModerationResult {
  provider: string
  flagged: boolean
  /** Normalised category names that triggered. */
  categories: string[]
}
export interface ModerationProvider {
  id: string
  moderate(text: string): Promise<ModerationResult>
}

export interface EmbeddingProvider {
  id: string
  dimensions: number
  embed(texts: string[]): Promise<number[][]>
}
