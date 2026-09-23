/**
 * daily-briefing.mjs — Morning briefing agent
 *
 * Scans Supabase for pending/failed tasks, asks Claude to summarise
 * the state of play, and optionally posts to a webhook.
 *
 * Run manually:     node scripts/daily-briefing.mjs
 * Schedule (cron):  0 8 * * * node /path/to/scripts/daily-briefing.mjs
 */

import { createClient } from '@supabase/supabase-js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { assertOpsAgentsEnabled } from './lib-agent-permissions.mjs'

// Kill switch: ops agents are off unless OPS_AGENTS_ENABLED=true.
assertOpsAgentsEnabled('daily-briefing')

const execFileAsync = promisify(execFile)
const CLAUDE = 'C:\\Users\\LTAGB\\AppData\\Roaming\\npm\\claude.cmd'
const __dirname = dirname(fileURLToPath(import.meta.url))

// Load env
const envPath = join(__dirname, '..', '.env.local')
try {
  const envFile = readFileSync(envPath, 'utf8')
  for (const line of envFile.split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/)
    if (match) process.env[match[1].trim()] = match[2].trim()
  }
} catch {}

const supabase = createClient(
  process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

console.log('📋 Generating daily briefing...\n')

const { data: todos } = await supabase
  .from('todos')
  .select('*')
  .order('created_at', { ascending: false })

if (!todos?.length) {
  console.log('No tasks found. Queue is empty.')
  process.exit(0)
}

const pending   = todos.filter(t => t.status === 'pending')
const active    = todos.filter(t => t.status === 'in_progress')
const failed    = todos.filter(t => t.status === 'failed')
const blocked   = todos.filter(t => t.status === 'blocked')
const completed = todos.filter(t => t.status === 'completed')

const taskList = todos.map(t =>
  `- [${t.status.toUpperCase()}] [${t.priority}] ${t.title}${t.assigned_agent ? ` (agent: ${t.assigned_agent})` : ''}`
).join('\n')

const prompt = `You are a briefing agent. Here is the current task queue:

${taskList}

Stats:
- Active: ${active.length}
- Pending: ${pending.length}
- Failed: ${failed.length}
- Blocked: ${blocked.length}
- Completed: ${completed.length}

Write a short daily briefing (3-5 sentences). Cover:
1. What agents are currently working on
2. Any tasks that need attention (failed, blocked)
3. Overall momentum / recommendation

Keep it concise and professional. Start with "DAILY BRIEFING —"`

try {
  const { stdout } = await execFileAsync(CLAUDE, [
    '-p',
    '--model', 'haiku',
    '--max-budget-usd', '0.02',
    prompt,
  ], { timeout: 30_000 })

  const briefing = stdout.trim()
  console.log('─'.repeat(60))
  console.log(briefing)
  console.log('─'.repeat(60))

  // Post to webhook if configured
  const webhookUrl = process.env.WEBHOOK_URL
  if (webhookUrl) {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: briefing }),
    })
    console.log('\n✓ Posted to webhook')
  }
} catch (err) {
  // Fallback: plain text briefing without Claude
  console.log('─'.repeat(60))
  console.log(`DAILY BRIEFING — ${new Date().toLocaleDateString()}`)
  console.log(`Active: ${active.length} | Pending: ${pending.length} | Failed: ${failed.length} | Blocked: ${blocked.length} | Done: ${completed.length}`)
  if (failed.length > 0) console.log(`\n⚠ Failed tasks:\n${failed.map(t => `  - ${t.title}`).join('\n')}`)
  if (blocked.length > 0) console.log(`\n⊘ Blocked tasks:\n${blocked.map(t => `  - ${t.title}`).join('\n')}`)
  if (pending.length > 0) console.log(`\nUp next:\n${pending.slice(0, 3).map(t => `  - [${t.priority}] ${t.title}`).join('\n')}`)
  console.log('─'.repeat(60))
}
