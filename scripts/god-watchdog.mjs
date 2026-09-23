// scripts/god-watchdog.mjs
//
// Separate PM2 process that monitors God's heartbeat. If God's god_status
// row hasn't ticked in >10 minutes, or the last 20 tasks have a fail rate
// >50%, the watchdog restarts the god process via pm2.
//
// Cheap (one Supabase query every 2 min, no LLM calls). Runs forever.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'

import { assertOpsAgentsEnabled } from './lib-agent-permissions.mjs'

// Kill switch: ops agents are off unless OPS_AGENTS_ENABLED=true.
assertOpsAgentsEnabled('god-watchdog')

const __filename   = fileURLToPath(import.meta.url)
const __dirname    = dirname(__filename)
const PROJECT_ROOT = join(__dirname, '..')

// Load env like the other scripts do
try {
  const raw = readFileSync(join(PROJECT_ROOT, '.env.local'), 'utf8')
  for (const line of raw.split('\n')) {
    if (!line.includes('=')) continue
    const i = line.indexOf('=')
    const k = line.slice(0, i).trim()
    const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, '')
    if (!process.env[k]) process.env[k] = v
  }
} catch {}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
)

const CHECK_INTERVAL_MS        = 2 * 60_000
const HEARTBEAT_STALE_MS       = 10 * 60_000
const FAIL_RATE_WINDOW         = 20
const FAIL_RATE_THRESHOLD      = 0.5
const RESTART_COOLDOWN_MS      = 15 * 60_000

let lastRestartAt = 0

function pmRestartGod() {
  if (Date.now() - lastRestartAt < RESTART_COOLDOWN_MS) {
    console.log('[WATCHDOG] restart cooldown active, skipping')
    return false
  }
  try {
    execSync('pm2 restart god --update-env', { encoding: 'utf8', timeout: 15_000 })
    lastRestartAt = Date.now()
    console.log('[WATCHDOG] 🔁 pm2 restart god issued')
    return true
  } catch (e) {
    console.log(`[WATCHDOG] pm2 restart failed: ${e.message?.slice(0, 120)}`)
    return false
  }
}

// ── Pending-commit verification (runtime regression detector) ─────────────
const PENDING_PATH = join(PROJECT_ROOT, 'scripts', 'pending-commits.json')
const CHECK_AFTER_TASKS      = 20
const REGRESSION_THRESHOLD_PP = 15 // percentage points drop triggers revert

async function loadPending() {
  try { return JSON.parse(readFileSync(PENDING_PATH, 'utf8')) } catch { return { pending: [] } }
}

function savePending(log) {
  try { writeFileSync(PENDING_PATH, JSON.stringify(log, null, 2), 'utf8') } catch {}
}

async function checkPendingCommits() {
  const log = await loadPending()
  const pending = log.pending ?? []
  if (!pending.length) return
  const keep = []

  for (const entry of pending) {
    // How many tasks closed AFTER this commit's timestamp?
    const { data: after } = await supabase
      .from('todos')
      .select('status, updated_at')
      .in('status', ['completed', 'failed'])
      .gte('updated_at', entry.at)
      .order('updated_at', { ascending: true })
      .limit(CHECK_AFTER_TASKS)

    if (!after || after.length < CHECK_AFTER_TASKS) {
      // Not enough evidence yet — keep waiting
      keep.push(entry)
      continue
    }

    // 20 tasks BEFORE the commit
    const { data: before } = await supabase
      .from('todos')
      .select('status')
      .in('status', ['completed', 'failed'])
      .lt('updated_at', entry.at)
      .order('updated_at', { ascending: false })
      .limit(CHECK_AFTER_TASKS)

    if (!before || before.length < CHECK_AFTER_TASKS) {
      keep.push(entry)
      continue
    }

    const rateBefore = before.filter(r => r.status === 'completed').length / before.length
    const rateAfter  = after.filter(r => r.status === 'completed').length / after.length
    const dropPP     = Math.round((rateBefore - rateAfter) * 100)

    if (dropPP >= REGRESSION_THRESHOLD_PP) {
      console.log(`[WATCHDOG] ⚠ regression detected on ${entry.sha} — rate ${Math.round(rateBefore*100)}% → ${Math.round(rateAfter*100)}% (-${dropPP}pp). Reverting.`)
      try {
        execSync(`git revert --no-edit ${entry.sha}`, { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 15_000 })
        const notifyWebhook = process.env.DISCORD_WEBHOOK_URL
        if (notifyWebhook) {
          try {
            await fetch(notifyWebhook, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ content: `🔁 Runtime regression: reverted ${entry.sha} (cycle ${entry.cycle}, source=${entry.source}). Success rate ${Math.round(rateBefore*100)}% → ${Math.round(rateAfter*100)}%.` }),
            })
          } catch {}
        }
      } catch (e) {
        console.log(`[WATCHDOG] revert failed for ${entry.sha}: ${e.message?.slice(0, 120)}`)
      }
      // don't keep — it's handled
    } else {
      console.log(`[WATCHDOG] ✓ ${entry.sha} verified (before ${Math.round(rateBefore*100)}% → after ${Math.round(rateAfter*100)}%)`)
      // don't keep — verified clean
    }
  }

  log.pending = keep
  savePending(log)
}

async function check() {
  await checkPendingCommits()
  try {
    // 1. Heartbeat — god_status.updated_at should tick every cycle
    const { data: status } = await supabase
      .from('god_status')
      .select('thought, updated_at')
      .eq('id', 1)
      .single()

    if (status?.updated_at) {
      const age = Date.now() - new Date(status.updated_at).getTime()
      if (age > HEARTBEAT_STALE_MS) {
        console.log(`[WATCHDOG] ⚠ God heartbeat stale: ${Math.round(age / 60_000)}m since last tick (thought: "${(status.thought ?? '').slice(0, 60)}")`)
        pmRestartGod()
        return
      }
    }

    // 2. Fail-rate — look at last N closed tasks
    const { data: recent } = await supabase
      .from('todos')
      .select('status')
      .in('status', ['completed', 'failed'])
      .order('updated_at', { ascending: false })
      .limit(FAIL_RATE_WINDOW)

    if (recent && recent.length >= 10) {
      const failed = recent.filter(r => r.status === 'failed').length
      const rate = failed / recent.length
      if (rate >= FAIL_RATE_THRESHOLD) {
        console.log(`[WATCHDOG] ⚠ Fail rate ${Math.round(rate * 100)}% over last ${recent.length} — pattern likely broken`)
        // Don't auto-restart on fail rate; that's usually a code bug, not a hang.
        // Just log + webhook so the user can investigate.
        const webhook = process.env.DISCORD_WEBHOOK_URL
        if (webhook) {
          try {
            await fetch(webhook, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ content: `⚠ Watchdog: fail rate ${Math.round(rate * 100)}% over last ${recent.length} tasks. Check dashboard.` }),
            })
          } catch {}
        }
      }
    }
  } catch (e) {
    console.log(`[WATCHDOG] check error: ${e.message?.slice(0, 120)}`)
  }
}

console.log('[WATCHDOG] online — checking God heartbeat every 2m')
await check()
setInterval(check, CHECK_INTERVAL_MS)
