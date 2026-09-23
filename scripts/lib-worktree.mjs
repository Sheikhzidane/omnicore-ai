// scripts/lib-worktree.mjs
//
// Per-task git worktree isolation (Composio agent-orchestrator pattern).
// Each specialist runs in its own sibling checkout so parallel agents can
// write files without stepping on each other. Commits in the worktree get
// fast-forwarded into main after the task completes.
//
// Opt-in via `USE_WORKTREES=true` in .env.local. Default OFF because the
// current sequential ruflo loop doesn't need it and worktrees add cleanup
// overhead. Flip on when you run >3 specialists concurrently.
//
// USAGE:
//   import { prepareWorkspace, commitWorkspace, cleanupWorkspace } from './lib-worktree.mjs'
//
//   const ws = await prepareWorkspace(todoId, PROJECT_ROOT)  // returns { path, cleanup }
//   try {
//     // run agent with cwd = ws.path  (refactor every tool to take cwd)
//     await commitWorkspace(ws.path, `agent: ${title}`)       // auto-merges to main
//   } finally {
//     await ws.cleanup()
//   }
//
// SAFETY:
//   - Worktrees go under <repo>/.agent-worktrees/<taskId> (gitignored)
//   - Each is a full Node modules-less checkout: symlink node_modules for speed
//   - Max 8 concurrent worktrees — rejects new ones above that
//   - Stale worktrees (>2h) get GC'd on next prepareWorkspace() call

import { execSync, execFileSync } from 'node:child_process'
import { violations } from './lib-agent-permissions.mjs'
import { existsSync, readdirSync, statSync, rmSync, symlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const WORKTREES_DIR_NAME = '.agent-worktrees'
const MAX_CONCURRENT     = 8
const STALE_AFTER_MS     = 2 * 60 * 60 * 1000

export function isEnabled() {
  return process.env.USE_WORKTREES === 'true'
}

function sh(cmd, cwd) {
  return execSync(cmd, { cwd, encoding: 'utf8', timeout: 30_000 }).trim()
}

function shQuiet(cmd, cwd) {
  try { return sh(cmd, cwd) } catch { return null }
}

function worktreesRoot(projectRoot) {
  return join(projectRoot, WORKTREES_DIR_NAME)
}

function gcStale(projectRoot) {
  const root = worktreesRoot(projectRoot)
  if (!existsSync(root)) return
  for (const name of readdirSync(root)) {
    const p = join(root, name)
    try {
      const age = Date.now() - statSync(p).mtime.getTime()
      if (age > STALE_AFTER_MS) {
        shQuiet(`git worktree remove --force "${p}"`, projectRoot)
        if (existsSync(p)) rmSync(p, { recursive: true, force: true })
      }
    } catch {}
  }
  shQuiet('git worktree prune', projectRoot)
}

function countActive(projectRoot) {
  const root = worktreesRoot(projectRoot)
  if (!existsSync(root)) return 0
  return readdirSync(root).length
}

export async function prepareWorkspace(todoId, projectRoot) {
  if (!isEnabled()) return { path: projectRoot, cleanup: async () => {}, isolated: false }

  gcStale(projectRoot)
  if (countActive(projectRoot) >= MAX_CONCURRENT) {
    console.log(`[WORKTREE] cap reached (${MAX_CONCURRENT}), falling back to shared tree`)
    return { path: projectRoot, cleanup: async () => {}, isolated: false }
  }

  const root = worktreesRoot(projectRoot)
  if (!existsSync(root)) mkdirSync(root, { recursive: true })

  const path   = join(root, todoId)
  const branch = `agent/${todoId}`

  // Clean up any zombie from a prior crash
  if (existsSync(path)) {
    shQuiet(`git worktree remove --force "${path}"`, projectRoot)
    if (existsSync(path)) rmSync(path, { recursive: true, force: true })
  }

  // Create the worktree on a fresh branch off main
  sh(`git worktree add "${path}" -b ${branch} main`, projectRoot)

  // Symlink node_modules so we don't reinstall ~500MB per agent
  const nm = join(projectRoot, 'node_modules')
  const wsNm = join(path, 'node_modules')
  if (existsSync(nm) && !existsSync(wsNm)) {
    try { symlinkSync(nm, wsNm, 'junction') } catch {}
  }

  const cleanup = async () => {
    try {
      shQuiet(`git worktree remove --force "${path}"`, projectRoot)
      if (existsSync(path)) rmSync(path, { recursive: true, force: true })
      shQuiet(`git branch -D ${branch}`, projectRoot)
    } catch {}
  }

  return { path, branch, cleanup, isolated: true }
}

/** Commit all changes in the worktree, then merge into main and delete branch. */
export async function commitWorkspace(wsPath, message, projectRoot) {
  if (!isEnabled() || wsPath === projectRoot) return { committed: false, reason: 'not-isolated' }

  try {
    const status = shQuiet('git status --porcelain', wsPath)
    if (!status) return { committed: false, reason: 'no-changes' }

    // Permission boundary: refuse if any changed path is protected.
    const changed = execFileSync('git', ['status', '--porcelain', '-z', '--no-renames', '--untracked-files=all'], { cwd: wsPath, encoding: 'utf8' })
      .split('\0').filter(Boolean).map(l => l.slice(3))
    const blocked = violations(changed, wsPath)
    if (blocked.length) return { committed: false, reason: `permission-denied: ${blocked.map(b => b.path ?? b.reason).join(', ')}` }
    execFileSync('git', ['add', '--', ...changed], { cwd: wsPath, stdio: 'pipe' })
    execFileSync('git', ['commit', '-m', String(message).slice(0, 200)], { cwd: wsPath, stdio: 'pipe' })

    // Fast-forward merge into main from the project root
    const branch = shQuiet('git rev-parse --abbrev-ref HEAD', wsPath)
    if (branch) sh(`git merge --ff-only ${branch}`, projectRoot)

    return { committed: true, branch }
  } catch (e) {
    return { committed: false, reason: e.message?.slice(0, 120) }
  }
}

/**
 * Integration note (not auto-wired):
 *
 * To enable worktrees in ruflo-runner.mjs, you need to thread a `cwd` through
 * the ~30 tool calls that currently hardcode `cwd: PROJECT_ROOT`. The shortest
 * path:
 *
 *   1. In runAgent(), before runAgentLoop():
 *        const ws = await prepareWorkspace(todo.id, PROJECT_ROOT)
 *        const cwd = ws.path
 *   2. Pass `cwd` into runAgentLoop() and have each tool case use it instead
 *      of PROJECT_ROOT. Search-replace: `cwd: PROJECT_ROOT` → `cwd`.
 *   3. After completion, before ws.cleanup():
 *        await commitWorkspace(ws.path, `[${agentName}] ${todo.title.slice(0,60)}`, PROJECT_ROOT)
 *   4. Set USE_WORKTREES=true in .env.local.
 *
 * Test with a single specialist before running all 4 in parallel.
 */
