/**
 * assign-agent.mjs — Assign a task to ruflo and watch it run
 *
 * Usage:
 *   node scripts/assign-agent.mjs "Build a login form" high
 *   node scripts/assign-agent.mjs <existing-task-id> --pick
 *
 * This creates (or updates) a task and marks it for ruflo pickup.
 * Run ruflo-runner.mjs in another terminal to process it.
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { assertOpsAgentsEnabled } from './lib-agent-permissions.mjs'

// Kill switch: ops agents are off unless OPS_AGENTS_ENABLED=true.
assertOpsAgentsEnabled('assign-agent')

const __dirname = dirname(fileURLToPath(import.meta.url))
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

const [arg1, arg2] = process.argv.slice(2)

if (!arg1) {
  console.log(`
Usage:
  node scripts/assign-agent.mjs "Task title" [priority]
  node scripts/assign-agent.mjs <task-id> --pick

Priorities: low | medium | high | critical  (default: medium)
  `)
  process.exit(0)
}

if (arg2 === '--pick') {
  // Assign an existing task to ruflo
  const { data, error } = await supabase
    .from('todos')
    .update({ assigned_agent: 'ruflo-agent', status: 'pending' })
    .eq('id', arg1)
    .select()
    .single()

  if (error) { console.error('Error:', error.message); process.exit(1) }
  console.log(`✓ Task "${data.title}" assigned to ruflo — start ruflo-runner.mjs to process it`)

} else {
  // Create a new task assigned to ruflo
  const priority = ['low', 'medium', 'high', 'critical'].includes(arg2) ? arg2 : 'medium'

  const { data, error } = await supabase
    .from('todos')
    .insert({ title: arg1, priority, status: 'pending', assigned_agent: null })
    .select()
    .single()

  if (error) { console.error('Error:', error.message); process.exit(1) }
  console.log(`✓ Created task: ${data.id}`)
  console.log(`  Title:    "${data.title}"`)
  console.log(`  Priority: ${data.priority}`)
  console.log(`  Agent:    (orchestrator will assign automatically)`)
  console.log(`\n  Orchestrator will pick it up within 20 seconds.`)
}
