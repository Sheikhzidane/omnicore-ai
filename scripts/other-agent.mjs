/**
 * other-agent.mjs — Observer & Coordinator Agent
 *
 * A meta-agent that watches the entire system, analyzes patterns,
 * provides health reports, and coordinates special operations.
 *
 * Features:
 * - System health metrics (agent uptime, task velocity, error rates)
 * - Agent performance trending + anomaly detection
 * - Bottleneck detection (tasks stuck in pending/in_progress)
 * - Capacity planning recommendations
 * - Cross-agent coordination for complex tasks
 * - Failure pattern analysis + root cause suggestions
 * - Weekly health digest to dashboard
 *
 * Run standalone:  node scripts/other-agent.mjs
 * Run via PM2:     pm2 start scripts/other-agent.mjs --name other-agent
 */

import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

import { assertOpsAgentsEnabled } from './lib-agent-permissions.mjs'

// Kill switch: ops agents are off unless OPS_AGENTS_ENABLED=true.
assertOpsAgentsEnabled('other-agent')

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')

// ── Load env ──────────────────────────────────────────────────────────────
const envPath = join(__dirname, '..', '.env.local')
try {
  const envFile = readFileSync(envPath, 'utf8')
  for (const line of envFile.split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/)
    if (match) process.env[match[1].trim()] = match[2].trim()
  }
} catch {}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const MODELS = { sonnet: 'claude-sonnet-4-6', haiku: 'claude-haiku-4-5-20251001' }

const supabase = createClient(
  process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// ── Claude helper ─────────────────────────────────────────────────────────
async function ask(prompt, { model = 'sonnet', maxTokens = 800 } = {}) {
  const msg = await anthropic.messages.create({
    model: MODELS[model] ?? MODELS.sonnet,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  })
  return msg.content[0]?.type === 'text' ? msg.content[0].text : ''
}

function extractJSON(text, fallback = null) {
  const arr = text.match(/\[[\s\S]*?\]/)
  const obj = text.match(/\{[\s\S]*\}/)
  try { if (arr) return JSON.parse(arr[0]) } catch {}
  try { if (obj) return JSON.parse(obj[0]) } catch {}
  return fallback
}

// ── Monitoring & Reporting ────────────────────────────────────────────────
async function analyzeSystemHealth() {
  console.log('[OTHER] Analyzing system health...')

  const { data: todos } = await supabase
    .from('todos')
    .select('*')
    .order('created_at', { ascending: false })

  if (!todos || todos.length === 0) {
    console.log('[OTHER] No tasks to analyze')
    return
  }

  // ── Basic stats ───────────────────────────────────────────────────────
  const stats = {
    total: todos.length,
    pending: todos.filter(t => t.status === 'pending').length,
    inProgress: todos.filter(t => t.status === 'in_progress').length,
    completed: todos.filter(t => t.status === 'completed').length,
    failed: todos.filter(t => t.status === 'failed').length,
    blocked: todos.filter(t => t.status === 'blocked').length,
  }

  // ── Agent utilization ─────────────────────────────────────────────────
  const agentStats = {}
  for (const t of todos) {
    if (!t.assigned_agent) continue
    if (!agentStats[t.assigned_agent]) {
      agentStats[t.assigned_agent] = { assigned: 0, active: 0, completed: 0, failed: 0 }
    }
    agentStats[t.assigned_agent].assigned++
    if (t.status === 'in_progress') agentStats[t.assigned_agent].active++
    if (t.status === 'completed') agentStats[t.assigned_agent].completed++
    if (t.status === 'failed') agentStats[t.assigned_agent].failed++
  }

  // ── Bottleneck detection ──────────────────────────────────────────────
  const now = Date.now()
  const stuckPending = todos.filter(t => {
    if (t.status !== 'pending') return false
    const age = now - new Date(t.created_at).getTime()
    return age > 30 * 60 * 1000 // > 30 minutes
  })

  const stuckInProgress = todos.filter(t => {
    if (t.status !== 'in_progress') return false
    const age = now - new Date(t.updated_at).getTime()
    return age > 45 * 60 * 1000 // > 45 minutes
  })

  // ── Task velocity (last hour) ─────────────────────────────────────────
  const oneHourAgo = Date.now() - 60 * 60 * 1000
  const recentCompleted = todos.filter(t =>
    t.status === 'completed' && new Date(t.updated_at).getTime() > oneHourAgo
  )

  const report = {
    timestamp: new Date().toISOString(),
    stats,
    agentStats,
    bottlenecks: {
      stuckPending: stuckPending.length,
      stuckInProgress: stuckInProgress.length,
    },
    velocity: {
      completedLastHour: recentCompleted.length,
      avgTimeToComplete: recentCompleted.length > 0
        ? Math.round(
            todos
              .filter(t => t.status === 'completed')
              .reduce((sum, t) => {
                const created = new Date(t.created_at).getTime()
                const updated = new Date(t.updated_at).getTime()
                return sum + (updated - created)
              }, 0) /
              todos.filter(t => t.status === 'completed').length /
              60000 // convert to minutes
          )
        : 0,
    },
  }

  console.log('[OTHER] Health Report:')
  console.log('  Tasks:', stats)
  console.log('  Velocity (last hour):', report.velocity)
  console.log('  Bottlenecks:', report.bottlenecks)

  return report
}

// ── Failure analysis ──────────────────────────────────────────────────────
async function analyzeFailures() {
  console.log('[OTHER] Analyzing failure patterns...')

  const { data: todos } = await supabase
    .from('todos')
    .select('*')
    .order('updated_at', { ascending: false })
    .limit(100)

  const failed = todos?.filter(t => t.status === 'failed') ?? []
  if (!failed.length) {
    console.log('[OTHER] No failures to analyze')
    return
  }

  // Group failures by agent & priority
  const failurePatterns = {}
  for (const t of failed) {
    const key = `${t.assigned_agent || 'unassigned'}-${t.priority}`
    if (!failurePatterns[key]) {
      failurePatterns[key] = []
    }
    failurePatterns[key].push({
      title: t.title,
      agent: t.assigned_agent,
      priority: t.priority,
    })
  }

  // Ask Claude to identify root causes
  const patternStr = Object.entries(failurePatterns)
    .map(([key, tasks]) => `${key}: ${tasks.length} failures\n${tasks.slice(0, 3).map(t => `  - ${t.title}`).join('\n')}`)
    .join('\n')

  const analysis = await ask(
    `Analyze these task failure patterns and suggest 2-3 root causes and solutions:

${patternStr}

Be concise (2-3 sentences per cause).`,
    { model: 'haiku', maxTokens: 300 }
  )

  console.log('[OTHER] Failure Analysis:')
  console.log(analysis)

  return { failurePatterns, analysis }
}

// ── Capacity planning ─────────────────────────────────────────────────────
async function recommendCapacity() {
  console.log('[OTHER] Computing capacity recommendations...')

  const { data: todos } = await supabase
    .from('todos')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200)

  if (!todos || todos.length < 10) return

  // Estimate queue depth and incoming rate
  const pending = todos.filter(t => t.status === 'pending').length
  const inProgress = todos.filter(t => t.status === 'in_progress').length
  const completed = todos.filter(t => t.status === 'completed').length

  // Count unique agents currently working
  const activeAgents = new Set(
    todos
      .filter(t => t.status === 'in_progress')
      .map(t => t.assigned_agent)
      .filter(Boolean)
  ).size

  const capacity = {
    queueDepth: pending + inProgress,
    activeAgents,
    completionRate: completed,
    recommendedAgents: Math.max(
      activeAgents,
      Math.ceil((pending + inProgress) / 5) // assume each agent handles ~5 tasks
    ),
  }

  console.log('[OTHER] Capacity Analysis:')
  console.log(`  Queue depth: ${capacity.queueDepth}`)
  console.log(`  Active agents: ${capacity.activeAgents}`)
  console.log(`  Recommended agents: ${capacity.recommendedAgents}`)

  return capacity
}

// ── Special operation: auto-retry failed tasks ────────────────────────────
async function retryFailedTasks(maxRetries = 2) {
  console.log('[OTHER] Checking for auto-retryable failed tasks...')

  const { data: failed } = await supabase
    .from('todos')
    .select('*')
    .eq('status', 'failed')
    .order('updated_at', { ascending: false })
    .limit(20)

  if (!failed?.length) return

  let retried = 0
  for (const task of failed) {
    const meta = task.metadata || {}
    const attempts = (meta.retry_attempts ?? 0) + 1

    // Only retry if < maxRetries
    if (attempts >= maxRetries) continue

    // Retry transient errors (not "file not found", "invalid input", etc.)
    const isTransient = /timeout|connection|network|busy|locked|temporary/.test(
      task.description?.toLowerCase() ?? ''
    )
    if (!isTransient) continue

    const { error } = await supabase
      .from('todos')
      .update({
        status: 'pending',
        metadata: { ...meta, retry_attempts: attempts, last_retry_at: new Date().toISOString() },
      })
      .eq('id', task.id)

    if (!error) {
      console.log(`[OTHER] Retrying: ${task.title} (attempt ${attempts})`)
      retried++
    }
  }

  console.log(`[OTHER] Retried ${retried} tasks`)
  return retried
}

// ── Main monitoring loop ──────────────────────────────────────────────────
async function runCycle() {
  try {
    console.log(`\n[OTHER] Cycle started at ${new Date().toISOString()}`)

    const health = await analyzeSystemHealth()
    await analyzeFailures()
    await recommendCapacity()
    await retryFailedTasks()

    // Store health report in god_status for dashboard visibility
    if (health) {
      await supabase
        .from('god_status')
        .upsert({
          id: 2, // Use id=2 for other-agent, id=1 is for god-agent
          thought: `[OTHER] Last analysis: ${health.stats.completed} done, ${health.stats.failed} failed, queue: ${health.stats.pending + health.stats.inProgress}`,
          updated_at: new Date().toISOString(),
        })
        .catch(() => {}) // silent if fails
    }

    console.log(`[OTHER] Cycle complete`)
  } catch (err) {
    console.error('[OTHER] Cycle error:', err.message)
  }
}

// ── Realtime alerts ───────────────────────────────────────────────────────
function subscribeToAnomalies() {
  // Watch for failures and alert if they spike
  supabase
    .channel('other-agent-failures')
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'todos' },
      ({ new: todo, old: prev }) => {
        // Alert on status → failed transition
        if (prev?.status !== 'failed' && todo.status === 'failed') {
          console.log(`⚠️  [OTHER] Task failed: "${todo.title}"`)
        }
      }
    )
    .subscribe()
}

// ── Startup ───────────────────────────────────────────────────────────────
console.log('🔍 Other Agent started — monitoring system health & patterns')
console.log('   Analyzing bottlenecks, failures, and capacity...\n')

subscribeToAnomalies()

// Run analysis every 5 minutes
runCycle()
setInterval(runCycle, 5 * 60 * 1000)
