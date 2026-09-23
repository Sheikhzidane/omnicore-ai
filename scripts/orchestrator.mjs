/**
 * orchestrator.mjs — 24/7 task dispatcher
 *
 * Watches Supabase for unassigned pending tasks, analyzes them,
 * picks the best agent, and assigns them. Ruflo-runner then executes.
 *
 * Run standalone:  node scripts/orchestrator.mjs
 * Run via PM2:     pm2 start scripts/orchestrator.mjs --name orchestrator
 */

import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { assertOpsAgentsEnabled } from './lib-agent-permissions.mjs'

// Kill switch: ops agents are off unless OPS_AGENTS_ENABLED=true.
assertOpsAgentsEnabled('orchestrator')

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── Load env FIRST so ANTHROPIC_API_KEY is available ─────────────────────
const envPath = join(__dirname, '..', '.env.local')
try {
  const envFile = readFileSync(envPath, 'utf8')
  for (const line of envFile.split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/)
    if (match) process.env[match[1].trim()] = match[2].trim()
  }
} catch {}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const MODELS = { sonnet: 'claude-sonnet-4-6', haiku: 'claude-haiku-4-5-20251001', opus: 'claude-opus-4-6' }

async function runClaude(prompt, { model = 'haiku', maxTokens = 256 } = {}) {
  const msg = await anthropic.messages.create({
    model: MODELS[model] ?? MODELS.haiku,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  })
  return msg.content[0]?.type === 'text' ? msg.content[0].text : ''
}

const supabase = createClient(
  process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// ── Agent roster ──────────────────────────────────────────────────────────
const AGENTS = [
  { name: 'ruflo-coder',      model: 'sonnet', keywords: ['build','create','implement','fix','code','write','refactor','add','update','develop','deploy'] },
  { name: 'ruflo-analyst',    model: 'sonnet', keywords: ['analyze','analyse','review','audit','check','assess','evaluate','report','summarise','summarize'] },
  { name: 'ruflo-researcher', model: 'haiku',  keywords: ['research','find','search','look','investigate','explore','discover','gather','collect'] },
  { name: 'ruflo-writer',     model: 'haiku',  keywords: ['write','draft','generate','compose','document','describe','explain','format','email','digest'] },
  { name: 'ruflo-monitor',    model: 'haiku',  keywords: ['monitor','watch','track','check','status','ping','test','verify','validate','scan'] },
  { name: 'ruflo-scraper',    model: 'haiku',  keywords: ['scrape','fetch','crawl','download','extract','index','ingest','import'] },
]

const DEFAULT_AGENT = { name: 'ruflo-general', model: 'sonnet' }

// ── Smart routing: keyword match + optional Claude fallback ───────────────
function routeByKeyword(title) {
  const lower = title.toLowerCase()
  let best = null
  let bestScore = 0

  for (const agent of AGENTS) {
    const score = agent.keywords.filter(k => lower.includes(k)).length
    if (score > bestScore) { bestScore = score; best = agent }
  }

  return best ?? DEFAULT_AGENT
}

async function routeWithClaude(title) {
  const agentList = AGENTS.map(a => a.name).join(', ')
  try {
    const stdout = await runClaude(
      `You are a task router. Pick the best agent for this task.\nAvailable agents: ${agentList}, ruflo-general\nTask: "${title}"\nReply with ONLY the agent name, nothing else.`,
      { model: 'haiku', maxTokens: 50 }
    )
    const picked = stdout.trim().toLowerCase()
    return AGENTS.find(a => a.name === picked) ?? DEFAULT_AGENT
  } catch {
    return routeByKeyword(title)
  }
}

// ── Assign a task to an agent ─────────────────────────────────────────────
async function assignTask(todo) {
  const agent = await routeWithClaude(todo.title)

  const { error } = await supabase
    .from('todos')
    .update({ assigned_agent: agent.name })
    .eq('id', todo.id)

  if (error) {
    console.error(`[orchestrator] Failed to assign ${todo.id}: ${error.message}`)
  } else {
    console.log(`[orchestrator] "${todo.title}" → ${agent.name}`)
  }
}

// ── Swarm mode: split a complex task into subtasks ────────────────────────
async function maybeSpawnSwarm(todo) {
  if (todo.priority !== 'critical') return false

  // Ask Claude if this task should be split
  try {
    const stdout = await runClaude(
      `Is this task complex enough to split into 2-3 parallel subtasks?\nTask: "${todo.title}"\nReply with either:\n- "SINGLE" if it should be one task\n- "SPLIT: subtask1 | subtask2 | subtask3" if it should be split (max 3)`,
      { model: 'haiku', maxTokens: 128 }
    )
    const resp = stdout.trim()
    if (!resp.startsWith('SPLIT:')) return false

    const subtasks = resp.replace('SPLIT:', '').split('|').map(s => s.trim()).filter(Boolean)
    if (subtasks.length < 2) return false

    console.log(`[orchestrator] Spawning swarm for "${todo.title}": ${subtasks.length} subtasks`)

    // Mark original as in_progress (coordinator)
    await supabase.from('todos').update({ status: 'in_progress', assigned_agent: 'ruflo-orchestrator' }).eq('id', todo.id)

    // Create subtasks
    for (const subtask of subtasks) {
      const agent = routeByKeyword(subtask)
      await supabase.from('todos').insert({
        title: subtask,
        priority: 'high',
        status: 'pending',
        assigned_agent: agent.name,
      })
      console.log(`[orchestrator] Subtask: "${subtask}" → ${agent.name}`)
    }

    return true
  } catch {
    return false
  }
}

// ── Main poll loop ────────────────────────────────────────────────────────
const processing = new Set()

// Suppresses repeated "fetch failed" errors when Supabase has a transient
// network blip — logs once per 30s instead of every 20s poll.
let lastPollErrorAt = 0

async function dispatch() {
  let result
  try {
    result = await supabase
      .from('todos')
      .select('*')
      .eq('status', 'pending')
      .is('assigned_agent', null)
      .order('created_at', { ascending: true })
      .limit(10)
  } catch (e) {
    // Transient network error — Supabase did a reconnect or a brief DNS issue
    const now = Date.now()
    if (now - lastPollErrorAt > 30_000) {
      console.error('[orchestrator] Poll network error:', e.message?.slice(0, 120))
      lastPollErrorAt = now
    }
    return
  }

  const { data, error } = result
  if (error) {
    const now = Date.now()
    if (now - lastPollErrorAt > 30_000) {
      console.error('[orchestrator] Poll error:', error.message)
      lastPollErrorAt = now
    }
    return
  }
  if (!data?.length) return

  for (const todo of data) {
    if (processing.has(todo.id)) continue
    processing.add(todo.id)

    try {
      const swarmed = await maybeSpawnSwarm(todo)
      if (!swarmed) await assignTask(todo)
    } finally {
      processing.delete(todo.id)
    }
  }
}

// ── Realtime: catch new unassigned tasks instantly ────────────────────────
supabase
  .channel('orchestrator-watch')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'todos' }, ({ new: todo }) => {
    if (todo.status === 'pending' && !todo.assigned_agent) {
      console.log(`[orchestrator] New unassigned task: "${todo.title}"`)
      setTimeout(() => dispatch(), 500)
    }
  })
  .subscribe()

// ── Stuck-task watchdog ───────────────────────────────────────────────────
// Any task stuck in `in_progress` longer than the category's timeout gets
// auto-failed so the slot frees up and the failure is learned from.
const STUCK_TIMEOUT_MIN = Number(process.env.STUCK_TIMEOUT_MIN ?? 15)
const CATEGORY_TIMEOUTS = {
  db:       Number(process.env.STUCK_TIMEOUT_DB       ?? 20),
  ui:       Number(process.env.STUCK_TIMEOUT_UI       ?? 25),
  infra:    Number(process.env.STUCK_TIMEOUT_INFRA    ?? 15),
  analysis: Number(process.env.STUCK_TIMEOUT_ANALYSIS ?? 15),
  other:    STUCK_TIMEOUT_MIN,
}

let lastWatchdogErrorAt = 0

async function reapStuckTasks() {
  let result
  try {
    result = await supabase
      .from('todos')
      .select('id, title, assigned_agent, task_category, updated_at, comments')
      .eq('status', 'in_progress')
      .limit(50)
  } catch (e) {
    const now = Date.now()
    if (now - lastWatchdogErrorAt > 60_000) {
      console.error('[watchdog] Poll network error:', e.message?.slice(0, 120))
      lastWatchdogErrorAt = now
    }
    return
  }
  const { data, error } = result
  if (error) {
    const now = Date.now()
    if (now - lastWatchdogErrorAt > 60_000) {
      console.error('[watchdog] Poll error:', error.message)
      lastWatchdogErrorAt = now
    }
    return
  }

  const now = Date.now()
  for (const t of data ?? []) {
    const ageMin = (now - new Date(t.updated_at).getTime()) / 60_000
    const timeout = CATEGORY_TIMEOUTS[t.task_category] ?? STUCK_TIMEOUT_MIN
    if (ageMin < timeout) continue

    console.log(`[watchdog] Reaping "${t.title.slice(0, 50)}" — stuck ${Math.round(ageMin)}min (>${timeout})`)
    const comments = Array.isArray(t.comments) ? t.comments : []
    comments.push({
      agent: 'watchdog',
      at:    new Date().toISOString(),
      text:  `Auto-failed: stuck in_progress ${Math.round(ageMin)}min (timeout ${timeout}min for ${t.task_category})`,
    })
    await supabase
      .from('todos')
      .update({ status: 'failed', comments })
      .eq('id', t.id)
  }
}

// ── Startup ───────────────────────────────────────────────────────────────
console.log('🤖 Orchestrator started — auto-assigning tasks 24/7')
console.log(`   Watchdog: ${STUCK_TIMEOUT_MIN}min default · db=${CATEGORY_TIMEOUTS.db}min · ui=${CATEGORY_TIMEOUTS.ui}min`)
console.log('   Watching for unassigned pending tasks...\n')

dispatch()
setInterval(dispatch, 20_000)         // poll every 20s as fallback
setInterval(reapStuckTasks, 60_000)   // reap stuck tasks every minute
reapStuckTasks()
