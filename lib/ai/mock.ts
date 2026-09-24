import type { z } from 'zod'
import type { ImageProvider, ModerationProvider, TextProvider, TextRequest, TextResult, VideoProvider } from './types'

/**
 * DETERMINISTIC MOCK PROVIDERS — automated tests and local development ONLY.
 * Enabled solely by AI_PROVIDER_MODE=mock and refused when NODE_ENV is
 * 'production' (lib/ai/registry.ts). Every output is labelled [MOCK] so it
 * can never be mistaken for real generated content.
 */

export const MOCK_LABEL = '[MOCK]'

export function createMockTextProvider(fixtures: (req: TextRequest<unknown>) => unknown = () => ({})): TextProvider {
  return {
    id: 'mock',
    async generate<T>(req: TextRequest<T>): Promise<TextResult<T>> {
      const raw = fixtures(req as TextRequest<unknown>)
      const data = req.schema ? (req.schema as z.ZodType<T>).parse(raw) : undefined
      return {
        provider: 'mock',
        model: 'mock',
        text: `${MOCK_LABEL} ${JSON.stringify(raw)}`,
        data,
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.001,
      }
    },
  }
}

// 1x1 transparent PNG.
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

export const mockImageProvider: ImageProvider = {
  id: 'mock',
  async generate() { return { provider: 'mock', model: 'mock', images: [{ mimeType: 'image/png', base64: PIXEL }], costUsd: 0 } },
}

export const mockVideoProvider: VideoProvider = {
  id: 'mock',
  async start() { return { jobId: 'mock-job', status: 'completed' } },
  async status() { return { status: 'completed' } },
  async download() { return { mimeType: 'video/mp4', bytes: new ArrayBuffer(8) } },
}

/** Flags text containing the word "forbidden" — lets tests exercise both paths. */
export const mockModerationProvider: ModerationProvider = {
  id: 'mock',
  async moderate(text) {
    const flagged = /\bforbidden\b/i.test(text)
    return { provider: 'mock', flagged, categories: flagged ? ['test_flag'] : [] }
  },
}
