/**
 * weekly-digest.mjs — Weekly digest summary
 *
 * Scans Supabase for tasks completed in the last 7 days, calculates metrics,
 * asks Claude to generate a comprehensive weekly summary, and posts to webhook.
 *
 * Run manually:     node scripts/weekly-digest.mjs
 * Schedule (cron):  0 8 * * 1 node /path/to/scripts/weekly-digest.mjs (Mondays at 8am)
 */

import { createClient } from '@supabase/supabase-js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { assertOpsAgentsEnabled } from './lib-agent-permissions.mjs'

// Kill switch: ops agents are off unless OPS_AGENTS_ENABLED=true.
assertOpsAgentsEnabled('weekly-digest')

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

console.log('📊 Generating weekly digest...\n')

// Get tasks from the last 7 days
const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

const { data: todos } = await supabase
  .from('todos')
  .select('*')
  .gte('created_at', sevenDaysAgo)
  .order('created_at', { ascending: false })

if (!todos?.length) {
  console.log('No tasks created in the last 7 days.')
  console.log('\n─'.repeat(60))
  console.log(`WEEKLY DIGEST — ${new Date().toLocaleDateString()}`)
  console.log('Queue is empty this week. No new tasks were created.')
  console.log('─'.repeat(60))
  process.exit(0)
}

// Calculate metrics
const completed   = todos.filter(t => t.status === 'completed')
const failed      = todos.filter(t => t.status === 'failed')
const pending     = todos.filter(t => t.status === 'pending')
const active      = todos.filter(t => t.status === 'in_progress')
const blocked     = todos.filter(t => t.status === 'blocked')

const criticalCount = todos.filter(t => t.priority === 'critical').length
const highCount     = todos.filter(t => t.priority === 'high').length

// Agent activity
const agents = new Map()
todos.forEach(t => {
  if (t.assigned_agent) {
    agents.set(t.assigned_agent, (agents.get(t.assigned_agent) || 0) + 1)
  }
})

const completionRate = todos.length > 0 ? ((completed.length / todos.length) * 100).toFixed(1) : 0

const taskList = todos.map(t =>
  `- [${t.status.toUpperCase()}] [${t.priority}] ${t.title}${t.assigned_agent ? ` (${t.assigned_agent})` : ''}`
).join('\n')

const agentSummary = Array.from(agents.entries())
  .map(([agent, count]) => `  • ${agent}: ${count} tasks`)
  .join('\n')

const prompt = `You are a weekly digest generator. Here is the summary of tasks created this week:

TASK SUMMARY:
${taskList}

METRICS:
- Total tasks: ${todos.length}
- Completed: ${completed.length} (${completionRate}%)
- Failed: ${failed.length}
- In Progress: ${active.length}
- Pending: ${pending.length}
- Blocked: ${blocked.length}
- Critical: ${criticalCount}
- High Priority: ${highCount}

AGENT ACTIVITY:
${agentSummary || '  (No agents assigned)'}

Week ending: ${new Date().toLocaleDateString()}

Write a professional weekly digest (5-8 sentences). Include:
1. Overall completion rate and momentum
2. Key accomplishments (completed tasks)
3. Problem areas (failed/blocked tasks needing attention)
4. Agent performance highlights
5. Recommendations for next week
6. Any blockers or risks

Start with "WEEKLY DIGEST —" and include the date.`

try {
  const { stdout } = await execFileAsync(CLAUDE, [
    '-p',
    '--model', 'haiku',
    '--max-budget-usd', '0.05',
    prompt,
  ], { timeout: 30_000 })

  const digest = stdout.trim()
  console.log('─'.repeat(60))
  console.log(digest)
  console.log('─'.repeat(60))

  // Post to webhook if configured
  const webhookUrl = process.env.WEBHOOK_URL
  if (webhookUrl) {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: digest }),
    })
    console.log('\n✓ Posted to webhook')
  }
} catch (err) {
  // Fallback: plain text digest without Claude
  console.log('─'.repeat(60))
  console.log(`WEEKLY DIGEST — ${new Date().toLocaleDateString()}`)
  console.log(`\nCompletion Rate: ${completionRate}% (${completed.length}/${todos.length} completed)`)
  console.log(`\nStatus Breakdown:`)
  console.log(`  • Completed: ${completed.length}`)
  console.log(`  • Failed: ${failed.length}`)
  console.log(`  • In Progress: ${active.length}`)
  console.log(`  • Pending: ${pending.length}`)
  console.log(`  • Blocked: ${blocked.length}`)
  
  if (completed.length > 0) {
    console.log(`\n✓ Completed this week:`)
    completed.slice(0, 5).forEach(t => {
      console.log(`  • [${t.priority.toUpperCase()}] ${t.title}`)
    })
  }
  
  if (failed.length > 0) {
    console.log(`\n✗ Failed tasks:`)
    failed.forEach(t => {
      console.log(`  • [${t.priority.toUpperCase()}] ${t.title}`)
    })
  }
  
  if (blocked.length > 0) {
    console.log(`\n⊘ Blocked tasks:`)
    blocked.slice(0, 3).forEach(t => {
      console.log(`  • [${t.priority.toUpperCase()}] ${t.title}`)
    })
  }

  if (agents.size > 0) {
    console.log(`\nAgent Activity:`)
    agents.forEach((count, agent) => {
      console.log(`  • ${agent}: ${count} tasks`)
    })
  }
  
  console.log('─'.repeat(60))
}
