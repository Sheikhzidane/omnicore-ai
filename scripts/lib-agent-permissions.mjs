// scripts/lib-agent-permissions.mjs
//
// Permission boundary for the inherited OPS agents (god-agent, ruflo-runner,
// orchestrator, self-modify, worktrees…). See docs/AGENT_PERMISSIONS.md.
//
// These agents historically could write ANY file in the repo, run arbitrary
// DDL, and commit + push with GITHUB_TOKEN. They are now:
//   1. OFF unless OPS_AGENTS_ENABLED=true           (assertOpsAgentsEnabled)
//   2. write-restricted to an allow-list, with an always-on deny-list for
//      auth, RLS, migrations, env files, secrets, packages/lockfiles, deploy
//      config, security middleware and this policy itself (checkWritePath)
//   3. unable to read secret files                   (checkReadPath)
//   4. unable to push, tag, release or run DDL/raw SQL (checkOperation)
//
// Pure functions (no side effects) except assertOpsAgentsEnabled; unit-tested
// in tests/agents/ops-permissions.test.mjs. Scripts under scripts/ are
// themselves on the deny-list, so an agent cannot edit this file to escape.

import { relative, resolve, sep, isAbsolute } from 'node:path'

/** Always denied, whatever the allow-list or env says. Matched against repo-relative POSIX paths. */
export const PROTECTED_PATTERNS = [
  /(^|\/)\.env(\..*)?$/,                // .env, .env.local, .env.production …
  /(^|\/)\.env\.[^/]*example$/,          // even examples (they document secret names)
  /\.(pem|key|p12|pfx|crt)$/i,           // key material
  /^supabase\//,                         // migrations, schema, RLS, seeds
  /(^|\/)migrations?\//,
  /^proxy\.ts$/, /^middleware\.ts$/,     // security middleware
  /^lib\/(auth|supabase|secrets|safety|agents|config)\//,
  /^lib\/(audit|rate-limit)\.ts$/,
  /^app\/(api|auth|login|logout)\//,     // route handlers + auth flow
  /^types\/database\.ts$/,
  /^(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/,
  /(^|\/)(package\.json|package-lock\.json)$/,
  /^\.github\//,                         // CI + deployment
  /^(vercel\.json|next\.config\.[cm]?[jt]s|ecosystem\.config\.cjs|tsconfig\.json|eslint\.config\.mjs|Dockerfile|docker-compose\.ya?ml)$/,
  /^scripts\//,                          // agent code, including this policy
  /^tests\//,                            // tests that enforce these boundaries
  /^docs\/(SECURITY|AGENT_PERMISSIONS|ARCHITECTURE)\.md$/,
  /^\.git(\/|$)/, /^node_modules\//, /^\.next\//,
]

/** Repo areas ops agents MAY write. Code areas additionally need OPS_AGENT_CODE_WRITES=true. */
export const SCRATCH_PREFIXES = ['docs/agent-notes/', 'agent-workspace/']
export const CODE_PREFIXES = ['app/(os)/ops/']
// Legacy flat dashboard components only (components/*.tsx) — not components/ui, shell, etc.
const LEGACY_COMPONENT = /^components\/[^/]+\.tsx$/

/** Secret material agents may not even read. */
const SECRET_READ_PATTERNS = [/(^|\/)\.env(\..*)?$/, /\.(pem|key|p12|pfx)$/i, /^\.git\//]

/** Operations that are never allowed for ops agents. */
export const FORBIDDEN_OPERATIONS = new Set([
  'git.push', 'git.tag', 'git.release', 'git.force', 'git.remote',
  'db.ddl', 'db.raw_sql', 'deploy', 'env.write', 'secrets.read',
])

function toRepoPath(p, projectRoot) {
  const abs = isAbsolute(p) ? resolve(p) : resolve(projectRoot, p)
  const rel = relative(projectRoot, abs)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  return rel.split(sep).join('/')
}

/** @returns {{ allowed: boolean, reason: string, path?: string }} */
export function checkWritePath(p, projectRoot, env = process.env) {
  const rel = toRepoPath(String(p ?? ''), projectRoot)
  if (!rel) return { allowed: false, reason: `path outside project: ${p}` }
  if (PROTECTED_PATTERNS.some(rx => rx.test(rel))) {
    return { allowed: false, path: rel, reason: `${rel} is protected (auth/security/infra/secrets/config) — agents may not modify it` }
  }
  if (SCRATCH_PREFIXES.some(pre => rel.startsWith(pre))) return { allowed: true, path: rel, reason: 'scratch area' }
  const codeWrites = env.OPS_AGENT_CODE_WRITES === 'true'
  if (CODE_PREFIXES.some(pre => rel.startsWith(pre)) || LEGACY_COMPONENT.test(rel)) {
    return codeWrites
      ? { allowed: true, path: rel, reason: 'legacy ops UI (OPS_AGENT_CODE_WRITES=true)' }
      : { allowed: false, path: rel, reason: 'code writes disabled (set OPS_AGENT_CODE_WRITES=true to allow legacy ops UI edits)' }
  }
  return { allowed: false, path: rel, reason: `${rel} is outside the agent write allow-list` }
}

/** @returns {{ allowed: boolean, reason: string }} */
export function checkReadPath(p, projectRoot) {
  const rel = toRepoPath(String(p ?? ''), projectRoot)
  if (!rel) return { allowed: false, reason: `path outside project: ${p}` }
  if (SECRET_READ_PATTERNS.some(rx => rx.test(rel))) return { allowed: false, reason: `${rel} contains secrets — agents may not read it` }
  return { allowed: true, reason: 'ok' }
}

/** @returns {{ allowed: boolean, reason: string }} */
export function checkOperation(op) {
  if (FORBIDDEN_OPERATIONS.has(op)) return { allowed: false, reason: `${op} is forbidden for agents` }
  return { allowed: true, reason: 'ok' }
}

/** Every staged/listed path must pass checkWritePath; returns the violations. */
export function violations(paths, projectRoot, env = process.env) {
  return paths.map(p => checkWritePath(p, projectRoot, env)).filter(r => !r.allowed)
}

/**
 * Kill switch. Ops agents only run when OPS_AGENTS_ENABLED=true. Call at the
 * top of every long-running agent script.
 */
export function opsAgentsEnabled(env = process.env) {
  return env.OPS_AGENTS_ENABLED === 'true'
}

export function assertOpsAgentsEnabled(name, env = process.env) {
  if (opsAgentsEnabled(env)) return
  console.log(`[${name}] disabled — ops agents are off by default. Set OPS_AGENTS_ENABLED=true to run (see docs/AGENT_PERMISSIONS.md).`)
  process.exit(0)
}
