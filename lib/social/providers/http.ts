import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { FetchFn } from './types'

/**
 * Untyped JSON from a third-party API. Each provider reads only the fields it
 * needs and converts them explicitly (String()/Number()) before use.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ApiJson = any

/** Error from a platform API. Messages never contain tokens or query strings. */
export class SocialApiError extends Error {
  constructor(public platform: string, public status: number, message: string, public retryable: boolean) {
    super(`${platform}: ${message}`)
    this.name = 'SocialApiError'
  }
}

/** A platform feature this integration does not (yet) support — never retried. */
export class UnsupportedPublishError extends Error {
  constructor(platform: string, what: string) {
    super(`${platform}: ${what} is not supported by this integration`)
    this.name = 'UnsupportedPublishError'
  }
}

const redactUrl = (u: string) => { try { const x = new URL(u); return `${x.origin}${x.pathname}` } catch { return 'request' } }

/** Pulls a human-readable message out of common API error shapes, capped and token-free. */
function errorMessage(body: unknown): string {
  if (!body || typeof body !== 'object') return typeof body === 'string' ? body.slice(0, 300) : 'request failed'
  const b = body as ApiJson
  const m = b.error?.message ?? b.error_description ?? b.error?.code ?? b.detail ?? b.title ?? b.message ?? (typeof b.error === 'string' ? b.error : null)
  return String(m ?? 'request failed').slice(0, 300)
}

export async function requestJson<T = ApiJson>(f: FetchFn, platform: string, url: string, init: RequestInit = {}): Promise<T> {
  let res: Response
  try {
    res = await f(url, init)
  } catch (e) {
    throw new SocialApiError(platform, 0, `network error calling ${redactUrl(url)}: ${(e as Error).message}`, true)
  }
  const text = await res.text()
  let body: unknown = text
  try { body = text ? JSON.parse(text) : {} } catch { /* keep text */ }
  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500
    throw new SocialApiError(platform, res.status, `${res.status} from ${redactUrl(url)}: ${errorMessage(body)}`, retryable)
  }
  return body as T
}

export const form = (o: Record<string, string>) => new URLSearchParams(o).toString()
export const FORM_HEADERS = { 'Content-Type': 'application/x-www-form-urlencoded' }
export const bearer = (token: string, extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${token}`, ...extra })
export const expiresAt = (seconds: number | undefined, now = Date.now()) => (seconds ? new Date(now + seconds * 1000).toISOString() : undefined)

export function pkcePair() {
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export function hmacHex(secret: string, data: string) { return createHmac('sha256', secret).update(data).digest('hex') }
export function hmacBase64(secret: string, data: string) { return createHmac('sha256', secret).update(data).digest('base64') }

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
