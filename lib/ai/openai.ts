import 'server-only'
import { ProviderError, ProviderNotConfiguredError, ProviderRefusalError, retryableStatus } from './errors'
import { jsonSchemaFor, parseStructured } from './json'
import type { EmbeddingProvider, ImageProvider, ModerationProvider, TextProvider, TextRequest, TextResult, VideoProvider } from './types'

/**
 * OpenAI adapter over the public REST API (no SDK dependency).
 * Status: IMPLEMENTED — EXTERNAL VERIFICATION REQUIRED (not exercised against
 * the live API in this build). Model names come from env; text generation has
 * no default model so we never guess one. Costs aren't computed (null/0).
 */

const BASE = 'https://api.openai.com/v1'
type Env = Record<string, string | undefined>
type Fetch = typeof fetch

async function call<T>(env: Env, path: string, init: RequestInit, f: Fetch = fetch): Promise<T> {
  const res = await f(`${BASE}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new ProviderError(`openai ${path}: HTTP ${res.status} ${body.slice(0, 300)}`, retryableStatus(res.status), res.status)
  }
  return res.json() as Promise<T>
}

export function openaiConfigured(env: Env): boolean {
  return !!env.OPENAI_API_KEY
}

export function createOpenAITextProvider(env: Env, f: Fetch = fetch): TextProvider {
  const models = { capable: env.OPENAI_TEXT_MODEL, fast: env.OPENAI_FAST_TEXT_MODEL || env.OPENAI_TEXT_MODEL }
  return {
    id: 'openai',
    async generate<T>(req: TextRequest<T>): Promise<TextResult<T>> {
      const model = models[req.tier ?? 'capable']
      if (!model) throw new ProviderNotConfiguredError('text generation (openai)', ['OPENAI_TEXT_MODEL'])
      const body = {
        model,
        max_completion_tokens: req.maxTokens ?? 4000,
        messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.prompt }],
        ...(req.schema ? { response_format: { type: 'json_schema', json_schema: { name: 'output', schema: jsonSchemaFor(req.schema) } } } : {}),
      }
      const r = await call<{ model: string; choices: { message: { content: string | null; refusal?: string | null } }[]; usage?: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens?: number } } }>(
        env, '/chat/completions', { method: 'POST', body: JSON.stringify(body) }, f)
      const msg = r.choices[0]?.message
      if (msg?.refusal) throw new ProviderRefusalError('openai', msg.refusal)
      const text = msg?.content ?? ''
      return {
        provider: 'openai',
        model: r.model,
        text,
        data: req.schema ? parseStructured(text, req.schema) : undefined,
        usage: {
          inputTokens: r.usage?.prompt_tokens ?? 0,
          outputTokens: r.usage?.completion_tokens ?? 0,
          cacheReadTokens: r.usage?.prompt_tokens_details?.cached_tokens ?? 0,
          cacheWriteTokens: 0,
        },
        costUsd: 0,
      }
    },
  }
}

export function createOpenAIImageProvider(env: Env, f: Fetch = fetch): ImageProvider {
  const model = env.OPENAI_IMAGE_MODEL || 'gpt-image-1'
  return {
    id: 'openai',
    async generate(req) {
      const prompt = req.negativePrompt ? `${req.prompt}\n\nAvoid: ${req.negativePrompt}` : req.prompt
      const r = await call<{ data: { b64_json: string }[] }>(env, '/images/generations', {
        method: 'POST', body: JSON.stringify({ model, prompt, size: req.size ?? '1024x1024', n: req.count ?? 1 }),
      }, f)
      return { provider: 'openai', model, images: r.data.map(d => ({ mimeType: 'image/png', base64: d.b64_json })), costUsd: null }
    },
  }
}

export function createOpenAIVideoProvider(env: Env, f: Fetch = fetch): VideoProvider {
  const model = env.OPENAI_VIDEO_MODEL || 'sora-2'
  const norm = (s: string) => (['queued', 'in_progress', 'completed', 'failed'].includes(s) ? s : 'in_progress') as 'queued' | 'in_progress' | 'completed' | 'failed'
  return {
    id: 'openai',
    async start(req) {
      const r = await call<{ id: string; status: string }>(env, '/videos', {
        method: 'POST', body: JSON.stringify({ model, prompt: req.prompt, seconds: String(req.seconds ?? 8), ...(req.size ? { size: req.size } : {}) }),
      }, f)
      return { jobId: r.id, status: norm(r.status) }
    },
    async status(jobId) {
      const r = await call<{ status: string; error?: { message?: string } }>(env, `/videos/${encodeURIComponent(jobId)}`, { method: 'GET' }, f)
      return { status: norm(r.status), error: r.error?.message }
    },
    async download(jobId) {
      const res = await f(`${BASE}/videos/${encodeURIComponent(jobId)}/content`, { headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` } })
      if (!res.ok) throw new ProviderError(`openai video download: HTTP ${res.status}`, retryableStatus(res.status), res.status)
      return { mimeType: res.headers.get('content-type') ?? 'video/mp4', bytes: await res.arrayBuffer() }
    },
  }
}

export function createOpenAIModerationProvider(env: Env, f: Fetch = fetch): ModerationProvider {
  const model = env.OPENAI_MODERATION_MODEL || 'omni-moderation-latest'
  return {
    id: 'openai',
    async moderate(input) {
      const r = await call<{ results: { flagged: boolean; categories: Record<string, boolean> }[] }>(env, '/moderations', {
        method: 'POST', body: JSON.stringify({ model, input }),
      }, f)
      const res = r.results[0]
      return { provider: 'openai', flagged: !!res?.flagged, categories: Object.entries(res?.categories ?? {}).filter(([, v]) => v).map(([k]) => k) }
    },
  }
}

export function createOpenAIEmbeddingProvider(env: Env, f: Fetch = fetch): EmbeddingProvider {
  const model = env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small'
  return {
    id: 'openai',
    dimensions: 1536,
    async embed(texts) {
      const r = await call<{ data: { embedding: number[] }[] }>(env, '/embeddings', { method: 'POST', body: JSON.stringify({ model, input: texts }) }, f)
      return r.data.map(d => d.embedding)
    },
  }
}
