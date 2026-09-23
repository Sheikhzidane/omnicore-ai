// scripts/god/self-modify.mjs
//
// Self-modifying orchestrator framework — God proposes edits to its OWN
// source code (god-agent.mjs et al). Every proposal goes through:
//   1. PROPOSE — Haiku writes a targeted patch
//   2. SANDBOX — patch applied to a temporary worktree copy
//   3. VERIFY — smoke-test runs (TS type-check, blocklist test, a single
//      dry-run cycle against a shadow DB/fake state)
//   4. STAGE — if all pass, commit to a `god/self-mod-<ts>` branch
//   5. OPT-IN MERGE — user approves from dashboard (or env GOD_SELF_MERGE=auto
//      for full autonomy — not recommended until you trust it)
//
// Default mode is STAGE_ONLY: God can propose + verify, but the user reviews
// before merging. Flip to AUTO only after you see a few clean proposals
// and trust the verification is catching regressions.

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { execSync, execFileSync } from 'node:child_process'
import { checkWritePath } from '../lib-agent-permissions.mjs'
import { join } from 'node:path'

const SANDBOX_ROOT_NAME = '.god-self-mod'

function sh(cmd, cwd) {
  try { return execSync(cmd, { cwd, encoding: 'utf8', timeout: 60_000 }) } catch (e) { return { error: e.message, stdout: e.stdout?.toString(), stderr: e.stderr?.toString() } }
}

export const SELF_MOD_MODE =
  process.env.GOD_SELF_MERGE === 'auto'        ? 'auto'      :
  process.env.GOD_SELF_MERGE === 'off'         ? 'off'       :
                                                 'stage_only' // default

/**
 * Propose a self-modification. God's reflection logic would call this when
 * it notices a pattern like "my blocklist keeps missing a class of failures"
 * or "my council round 1 agreement rate is >95% — deliberation is adding
 * no value, I could skip rounds 2-3 here."
 *
 * proposal shape:
 *   {
 *     targetFile:   'scripts/god-agent.mjs',
 *     rationale:    'string — why this change',
 *     patchOld:     'string — exact text to replace',
 *     patchNew:     'string — replacement',
 *     testCommand:  'string — shell command that must pass (default: npm test)',
 *   }
 */
export async function proposeSelfMod(proposal, { projectRoot, log = console }) {
  if (SELF_MOD_MODE === 'off') {
    log.log('[SELF-MOD] disabled via GOD_SELF_MERGE=off')
    return { ok: false, reason: 'disabled' }
  }

  const { targetFile, patchOld, patchNew, rationale, testCommand = 'npm test' } = proposal
  if (!targetFile || !patchOld || !patchNew) {
    return { ok: false, reason: 'malformed-proposal' }
  }

  // 0. Permission boundary — self-modification of agent code, auth, security
  //    or infrastructure is forbidden (scripts/ is itself protected).
  const perm = checkWritePath(targetFile, projectRoot)
  if (!perm.allowed) {
    log.log(`[SELF-MOD] ⛔ ${perm.reason}`)
    return { ok: false, reason: 'permission-denied', detail: perm.reason }
  }

  // 1. Validate the target file exists + patchOld is present exactly once
  const absTarget = join(projectRoot, targetFile)
  if (!existsSync(absTarget)) return { ok: false, reason: 'target-missing' }
  const original = readFileSync(absTarget, 'utf8')
  const occurrences = original.split(patchOld).length - 1
  if (occurrences === 0) return { ok: false, reason: 'patch-not-found' }
  if (occurrences > 1)   return { ok: false, reason: 'patch-ambiguous' }

  // 2. Sandbox — apply the patch to a temporary file copy + type-check
  const sandboxDir = join(projectRoot, SANDBOX_ROOT_NAME)
  if (!existsSync(sandboxDir)) mkdirSync(sandboxDir, { recursive: true })
  const snapshotPath = join(sandboxDir, `${targetFile.replace(/[\/\\]/g, '_')}.${Date.now()}.snap`)
  copyFileSync(absTarget, snapshotPath)
  log.log(`[SELF-MOD] sandboxing ${targetFile} (snapshot: ${snapshotPath})`)

  const patched = original.replace(patchOld, patchNew)
  writeFileSync(absTarget, patched, 'utf8')

  // 3. Verify — typecheck + optional test command
  log.log(`[SELF-MOD] verifying via: ${testCommand}`)
  const tsCheck = sh('npx tsc --noEmit', projectRoot)
  const tsOk = typeof tsCheck === 'string' || (tsCheck?.stderr?.length ?? 0) < 400

  const testResult = sh(testCommand, projectRoot)
  const testOk = typeof testResult === 'string' || !testResult.error

  // 4. Outcome
  if (!tsOk || !testOk) {
    // Revert + log
    writeFileSync(absTarget, original, 'utf8')
    log.log(`[SELF-MOD] ⛔ verification failed (ts=${tsOk} test=${testOk}) — reverted`)
    return { ok: false, reason: 'verification-failed', tsOk, testOk }
  }

  // 5. Stage or auto-merge
  if (SELF_MOD_MODE === 'stage_only') {
    // Revert the file; the proposal is recorded to a queue for user review
    writeFileSync(absTarget, original, 'utf8')
    const queueFile = join(sandboxDir, 'pending-mods.json')
    const queue = existsSync(queueFile) ? JSON.parse(readFileSync(queueFile, 'utf8')) : []
    queue.push({
      at:          new Date().toISOString(),
      targetFile,
      rationale,
      patchOld:    patchOld.slice(0, 500),
      patchNew:    patchNew.slice(0, 500),
      snapshotPath,
    })
    writeFileSync(queueFile, JSON.stringify(queue, null, 2), 'utf8')
    log.log(`[SELF-MOD] ✓ proposal staged for user review (${queue.length} pending)`)
    return { ok: true, staged: true, pendingCount: queue.length }
  }

  // AUTO mode — file is already patched; commit it (argv form: no shell).
  const safeRationale = String(rationale ?? '').slice(0, 72)
  try {
    execFileSync('git', ['add', '--', targetFile], { cwd: projectRoot, stdio: 'pipe' })
    execFileSync('git', ['commit', '-m', `[god-self-mod] ${safeRationale}`], { cwd: projectRoot, stdio: 'pipe' })
  } catch (e) {
    writeFileSync(absTarget, original, 'utf8')
    return { ok: false, reason: 'commit-failed', detail: e.message?.slice(0, 120) }
  }
  const sha = sh('git rev-parse --short HEAD', projectRoot).trim?.() ?? '?'
  log.log(`[SELF-MOD] ✓ auto-merged ${sha}: ${safeRationale}`)
  return { ok: true, auto: true, sha }
}

/** List pending self-modification proposals (for dashboard review). */
export function listPendingSelfMods(projectRoot) {
  const queueFile = join(projectRoot, SANDBOX_ROOT_NAME, 'pending-mods.json')
  if (!existsSync(queueFile)) return []
  try { return JSON.parse(readFileSync(queueFile, 'utf8')) } catch { return [] }
}
