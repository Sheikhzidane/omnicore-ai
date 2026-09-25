import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { INTEGRATIONS } from '@/lib/config/integrations'

// Product code (the legacy /ops area documents its optional variables separately).
const ROOTS = ['lib/ai', 'lib/agents', 'lib/analytics', 'lib/approvals', 'lib/auth', 'lib/config', 'lib/content', 'lib/email', 'lib/payments',
  'lib/publishing', 'lib/scheduling', 'lib/secrets', 'lib/social', 'lib/storage', 'lib/supabase', 'lib/cron.ts', 'lib/actions.ts',
  'app/(os)', 'app/api/cron', 'app/api/social', 'app/api/social-webhooks', 'app/api/webhooks/stripe', 'app/login', 'app/auth', 'proxy.ts']
const AUTO = new Set(['NODE_ENV', 'VERCEL'])

function files(p: string): string[] {
  if (statSync(p).isFile()) return [p]
  return readdirSync(p).flatMap(n => files(join(p, n))).filter(f => /\.tsx?$/.test(f) && !f.includes('/ops/'))
}

test('every env var the product reads is documented in docs/ENVIRONMENT.md and .env.example', () => {
  const doc = readFileSync('docs/ENVIRONMENT.md', 'utf8'), example = readFileSync('.env.example', 'utf8')
  const used = new Set<string>()
  for (const f of ROOTS.flatMap(files)) for (const m of readFileSync(f, 'utf8').matchAll(/\b(?:process\.env|env)\.([A-Z][A-Z0-9_]+)/g)) used.add(m[1])
  for (const i of INTEGRATIONS) i.requiredEnv.forEach(e => used.add(e))
  const undocumented = [...used].filter(v => !AUTO.has(v) && !doc.includes(`\`${v}\``))
  const notInExample = [...used].filter(v => !AUTO.has(v) && !new RegExp(`^${v}=`, 'm').test(example))
  assert.deepEqual(undocumented, [], 'missing from docs/ENVIRONMENT.md')
  assert.deepEqual(notInExample, [], 'missing from .env.example')
})

test('.env.example contains no values for secrets', () => {
  const secretish = /(KEY|SECRET|TOKEN)$/
  const filled = readFileSync('.env.example', 'utf8').split('\n').filter(l => /^[A-Z_]+=.+/.test(l))
    .filter(l => secretish.test(l.split('=')[0]) && !l.startsWith('NEXT_PUBLIC_'))
  assert.deepEqual(filled, [])
})
