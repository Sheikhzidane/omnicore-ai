#!/usr/bin/env node
/**
 * Fails if a tracked file contains something that looks like a real secret or
 * a real Supabase project URL, or if an env file other than .env.example is
 * tracked. Runs in CI and locally: `npm run check:committed-secrets`.
 * Test fixtures use obvious placeholders and never match these patterns.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'

const PATTERNS = [
  ['Anthropic API key', /sk-ant-[A-Za-z0-9_-]{24,}/],
  ['OpenAI API key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{40,}/],
  ['Stripe live key', /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/],
  ['Stripe webhook secret', /\bwhsec_[A-Za-z0-9]{24,}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{36}\b|github_pat_[A-Za-z0-9_]{40,}/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['Resend API key', /\bre_[A-Za-z0-9]{8}_[A-Za-z0-9]{20,}/],
  ['Private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['Real Supabase project URL', /https:\/\/(?!your-project-ref|example|project-ref|xxxx)[a-z0-9]{20}\.supabase\.co/],
]
const JWT = /eyJ[A-Za-z0-9_-]{10,}\.([A-Za-z0-9_-]{20,})\.[A-Za-z0-9_-]{20,}/g
const SKIP = /(^|\/)(node_modules|\.next|supabase\/legacy-migrations)\/|package-lock\.json$|\.(png|jpe?g|gif|webp|ico|woff2?|ttf|mp4|pdf)$/

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
const findings = []
for (const f of files) {
  if (/(^|\/)\.env(\.|$)/.test(f) && !f.endsWith('.env.example')) findings.push(`${f}: environment file is tracked`)
  if (SKIP.test(f)) continue
  let text
  try { if (statSync(f).size > 2_000_000) continue; text = readFileSync(f, 'utf8') } catch { continue }
  for (const [name, re] of PATTERNS) if (re.test(text)) findings.push(`${f}: ${name}`)
  for (const m of text.matchAll(JWT)) {
    try { if (/service_role/.test(Buffer.from(m[1], 'base64url').toString('utf8'))) findings.push(`${f}: Supabase service-role JWT`) } catch { /* not a JWT */ }
  }
}
if (findings.length) {
  console.error('✗ Possible committed secrets:\n' + findings.map(x => `  - ${x}`).join('\n'))
  process.exit(1)
}
console.log(`✓ No committed secrets found (${files.length} tracked files scanned).`)
