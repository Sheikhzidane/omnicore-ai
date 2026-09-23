#!/usr/bin/env node
// Fails (exit 1) if a secret could reach the browser:
//   1. source code or env templates expose a secret-like var via NEXT_PUBLIC_*
//   2. the built client bundle (.next/static) contains a server secret's NAME
//      or, when set in this environment, its VALUE.
// Run after `next build` (CI runs it with placeholder secret values).
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const SERVER_SECRETS = [
  'SUPABASE_SERVICE_ROLE_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'RESEND_API_KEY',
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'META_APP_SECRET', 'TIKTOK_CLIENT_SECRET',
  'GOOGLE_OAUTH_CLIENT_SECRET', 'X_CLIENT_SECRET', 'IMAGE_GENERATION_API_KEY', 'VIDEO_GENERATION_API_KEY',
  'CREDENTIALS_ENCRYPTION_KEY', 'CRON_SECRET', 'GITHUB_TOKEN', 'GITHUB_WEBHOOK_SECRET',
  'GENERIC_WEBHOOK_TOKEN', 'PANIC_TOKEN', 'ELEVENLABS_API_KEY', 'REDDIT_CLIENT_SECRET', 'TELEGRAM_BOT_TOKEN',
]
const PUBLIC_SECRET_NAME = /NEXT_PUBLIC_[A-Z0-9_]*(SECRET|SERVICE_ROLE|PRIVATE|PASSWORD|TOKEN|API_KEY)[A-Z0-9_]*/g

function walk(dir, exts, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.git', '.next'].includes(name) && dir === '.') continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, exts, out)
    else if (exts.some(e => name.endsWith(e))) out.push(p)
  }
  return out
}

const problems = []

for (const file of [...walk('.', ['.ts', '.tsx', '.js', '.mjs', '.cjs']), ...walk('.', ['.example'])]) {
  if (file.includes('node_modules') || file.startsWith('.next')) continue
  if (file.endsWith('check-env-exposure.mjs')) continue
  const hits = readFileSync(file, 'utf8').match(PUBLIC_SECRET_NAME)
  if (hits) problems.push(`${file}: secret-like public env var ${[...new Set(hits)].join(', ')}`)
}

const bundle = walk(join('.next', 'static'), ['.js'])
if (process.argv.includes('--require-build') && bundle.length === 0) {
  problems.push('no client bundle found in .next/static — run `next build` first')
}
for (const file of bundle) {
  const src = readFileSync(file, 'utf8')
  for (const name of SERVER_SECRETS) {
    // A bare name in help text ("set RESEND_API_KEY in .env.local") is fine;
    // client code READING the variable is not.
    if (new RegExp(`(process\\.env|env)(\\.|\\[['"])${name}\\b`).test(src)) problems.push(`${file}: client code reads server secret ${name}`)
    const value = process.env[name]
    if (value && value.length >= 8 && src.includes(value)) problems.push(`${file}: client bundle contains the VALUE of ${name}`)
  }
}

if (problems.length) {
  console.error(`✗ Secret exposure check failed:\n${problems.map(p => `  - ${p}`).join('\n')}`)
  process.exit(1)
}
console.log(`✓ No secrets exposed (${bundle.length} client bundle files scanned).`)
