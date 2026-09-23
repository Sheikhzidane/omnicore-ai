// Permission boundary for the inherited ops agents (scripts/lib-agent-permissions.mjs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { checkWritePath, checkReadPath, checkOperation, violations, opsAgentsEnabled } from '../../scripts/lib-agent-permissions.mjs'

const ROOT = resolve('.')
const on = { OPS_AGENT_CODE_WRITES: 'true' }

test('protected paths can never be written — even with code writes enabled', () => {
  const protectedPaths = [
    '.env', '.env.local', '.env.production', 'nested/.env.local', '.env.local.example',
    'supabase/migrations/20260923000000_tenancy.sql', 'supabase/legacy-migrations/0001_create_todos.sql',
    'proxy.ts', 'middleware.ts',
    'lib/auth/session.ts', 'lib/supabase/admin.ts', 'lib/secrets/credentials.ts', 'lib/safety/policy.ts',
    'lib/agents/permissions.ts', 'lib/config/integrations.ts', 'lib/audit.ts', 'lib/rate-limit.ts',
    'app/api/todos/route.ts', 'app/api/agents/control/route.ts', 'app/auth/callback/route.ts', 'app/login/actions.ts',
    'types/database.ts', 'package.json', 'package-lock.json', 'yarn.lock',
    '.github/workflows/ci.yml', 'vercel.json', 'next.config.mjs', 'ecosystem.config.cjs', 'tsconfig.json', 'eslint.config.mjs',
    'scripts/lib-agent-permissions.mjs', 'scripts/god-agent.mjs', 'scripts/god/self-modify.mjs',
    'tests/agents/ops-permissions.test.mjs', 'docs/SECURITY.md', 'docs/AGENT_PERMISSIONS.md',
    '.git/config', 'node_modules/x/index.js', 'certs/server.key', 'id.pem',
  ]
  for (const p of protectedPaths) {
    assert.equal(checkWritePath(p, ROOT, on).allowed, false, p)
  }
})

test('paths outside the project and traversal attempts are denied', () => {
  for (const p of ['/etc/passwd', '../outside.txt', 'agent-workspace/../../x', 'agent-workspace/../.env.local', resolve(ROOT, '..', 'x')]) {
    assert.equal(checkWritePath(p, ROOT, on).allowed, false, p)
  }
})

test('scratch areas are writable; legacy ops UI only with OPS_AGENT_CODE_WRITES', () => {
  assert.equal(checkWritePath('agent-workspace/notes.md', ROOT, {}).allowed, true)
  assert.equal(checkWritePath('docs/agent-notes/x.md', ROOT, {}).allowed, true)
  assert.equal(checkWritePath('components/TaskKanban.tsx', ROOT, {}).allowed, false)
  assert.equal(checkWritePath('components/TaskKanban.tsx', ROOT, on).allowed, true)
  assert.equal(checkWritePath('app/(os)/ops/page.tsx', ROOT, on).allowed, true)
})

test('product code stays out of reach of ops agents', () => {
  for (const p of ['components/ui/button.tsx', 'components/shell/sidebar.tsx', 'app/(os)/dashboard/page.tsx',
    'app/(os)/characters/page.tsx', 'app/layout.tsx', 'lib/nav.ts', 'README.md', 'app/topics/x/page.tsx']) {
    assert.equal(checkWritePath(p, ROOT, on).allowed, false, p)
  }
})

test('secret files cannot be read', () => {
  for (const p of ['.env', '.env.local', 'deploy/.env.production', 'key.pem', '.git/config']) {
    assert.equal(checkReadPath(p, ROOT).allowed, false, p)
  }
  assert.equal(checkReadPath('components/TaskKanban.tsx', ROOT).allowed, true)
})

test('push, release, DDL and raw SQL are forbidden operations', () => {
  for (const op of ['git.push', 'git.tag', 'git.release', 'db.ddl', 'db.raw_sql', 'deploy', 'env.write', 'secrets.read']) {
    assert.equal(checkOperation(op).allowed, false, op)
  }
})

test('a commit containing any protected path is refused as a whole', () => {
  const v = violations(['agent-workspace/a.md', 'lib/auth/session.ts'], ROOT, on)
  assert.equal(v.length, 1)
  assert.match(v[0].reason, /protected/)
})

test('kill switch: ops agents are off unless OPS_AGENTS_ENABLED=true', () => {
  assert.equal(opsAgentsEnabled({}), false)
  assert.equal(opsAgentsEnabled({ OPS_AGENTS_ENABLED: '1' }), false)
  assert.equal(opsAgentsEnabled({ OPS_AGENTS_ENABLED: 'true' }), true)
})

test('agent processes exit immediately when disabled; dangerous ones stay disabled even when enabled', () => {
  const env = { ...process.env }
  delete env.OPS_AGENTS_ENABLED
  for (const script of ['god-agent', 'ruflo-runner', 'orchestrator', 'revenue-agent', 'god-poster', 'seo-content-loop']) {
    const r = spawnSync(process.execPath, [`scripts/${script}.mjs`], { env, encoding: 'utf8', timeout: 20_000 })
    assert.equal(r.status, 0, script)
    assert.match(r.stdout, /disabled/, script)
  }
  for (const script of ['promote-agent', 'affiliate-injector', 'auto-release']) {
    const r = spawnSync(process.execPath, [`scripts/${script}.mjs`], { env: { ...env, OPS_AGENTS_ENABLED: 'true' }, encoding: 'utf8', timeout: 20_000 })
    assert.equal(r.status, 0, script)
    assert.match(r.stdout, /disabled:/, script)
  }
})

test('inherited agent code no longer contains push / DDL / auto-approve paths', async () => {
  const { readFileSync } = await import('node:fs')
  const god = readFileSync('scripts/god-agent.mjs', 'utf8')
  const runner = readFileSync('scripts/ruflo-runner.mjs', 'utf8')
  assert.doesNotMatch(god, /gitExec\(`git push/)
  assert.doesNotMatch(god, /GITHUB_TOKEN\}@/)
  assert.doesNotMatch(god, /rpc\('agent_exec_ddl'/)
  assert.doesNotMatch(god, /GOD_AUTO_APPROVE === 'true'/)
  assert.doesNotMatch(runner, /rpc\('agent_exec_ddl'/)
  assert.doesNotMatch(runner, /git add -A/)
  assert.doesNotMatch(runner, /git commit -m "\$\{/)
})
