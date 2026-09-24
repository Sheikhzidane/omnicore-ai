import { z } from 'zod'
import { ProviderOutputError } from './errors'

/** JSON Schema for structured-output requests, derived from the zod schema. */
export function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  const s = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>
  delete s.$schema
  return s
}

/** Parses model text as JSON (tolerating code fences) and validates it. */
export function parseStructured<T>(text: string, schema: z.ZodType<T>): T {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let raw: unknown
  try {
    raw = JSON.parse(cleaned)
  } catch {
    throw new ProviderOutputError('model output was not valid JSON')
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) throw new ProviderOutputError(`model output failed validation: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  return parsed.data
}
