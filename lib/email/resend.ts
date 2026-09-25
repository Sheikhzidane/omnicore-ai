import type { Env, FetchFn } from '@/lib/social/providers/types'

/**
 * Sends ONE human-approved outreach email through Resend. Never used for bulk
 * or unsolicited mailing: callers pass a single recipient whose consent basis
 * and do-not-contact status were checked. Every message states that it was
 * drafted with AI for an AI virtual character and offers an opt-out.
 * Env: RESEND_API_KEY, OUTREACH_FROM_EMAIL (a verified sender).
 */

export const emailConfigured = (env: Env) => Boolean(env.RESEND_API_KEY && env.OUTREACH_FROM_EMAIL)

export function outreachFooter(characterName: string): string {
  return [
    '—',
    `${characterName} is an AI virtual character. This message was drafted with AI assistance and reviewed and approved by ${characterName}'s human team before sending.`,
    'If you would prefer not to hear from us again, reply "unsubscribe" and we will not contact you further.',
  ].join('\n')
}

export async function sendApprovedEmail(env: Env, f: FetchFn, m: { to: string; subject: string; text: string; replyTo?: string; idempotencyKey: string }) {
  if (!emailConfigured(env)) throw new Error('email not configured')
  const res = await f('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': m.idempotencyKey },
    body: JSON.stringify({ from: env.OUTREACH_FROM_EMAIL, to: [m.to], subject: m.subject, text: m.text, ...(m.replyTo ? { reply_to: m.replyTo } : {}) }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`email send failed (${res.status}): ${String((body as { message?: string }).message ?? '').slice(0, 200)}`)
  return { id: String((body as { id?: string }).id ?? '') }
}
