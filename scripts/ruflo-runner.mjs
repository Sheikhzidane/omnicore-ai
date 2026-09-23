/**
 * ruflo-runner.mjs — Agentic code-editing runner v2
 *
 * Improvements over v1:
 * - patch_file tool: targeted edits instead of full rewrites
 * - create_subtask: agent can decompose complex tasks
 * - Smarter model routing: keyword-based Sonnet upgrades
 * - Pool-specific system prompts (critical/high/medium/low)
 * - Pre-flight validation: haiku sanity-checks approach before starting
 * - Read-before-write enforcement + warnings
 * - Context compression on long runs (>10 iterations)
 * - Self-healing: retry once on failure with error context
 * - Stale task detection: resets in_progress >10min to pending
 * - Wall-clock timeout: 8 minutes per agent run
 * - Parallel agents: up to 4 concurrent
 * - Error pattern matching from agent memory
 */

import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { assertOpsAgentsEnabled, checkWritePath, checkReadPath, checkOperation, violations } from './lib-agent-permissions.mjs'

// ── Load .env.local FIRST ──────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')
const envPath = join(PROJECT_ROOT, '.env.local')
try {
  const envFile = readFileSync(envPath, 'utf8')
  for (const line of envFile.split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/)
    if (match) process.env[match[1].trim()] = match[2].trim()
  }
} catch {}

// Kill switch: ops agents are off unless OPS_AGENTS_ENABLED=true.
assertOpsAgentsEnabled('ruflo-runner')

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const MODELS = { sonnet: 'claude-sonnet-4-6', haiku: 'claude-haiku-4-5-20251001', opus: 'claude-opus-4-6' }

const supabase = createClient(
  process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// ── Agent pool ─────────────────────────────────────────────────────────────
const AGENT_POOL = {
  critical:        { name: 'ruflo-critical',  model: 'sonnet' },
  high:            { name: 'ruflo-high',      model: 'haiku'  },
  medium:          { name: 'ruflo-medium',    model: 'haiku'  },
  low:             { name: 'ruflo-low',       model: 'haiku'  },
  // Specialist agents — always Sonnet, domain-tuned system prompts
  'db-specialist': { name: 'db-specialist',   model: 'sonnet' },
  'ui-specialist': { name: 'ui-specialist',   model: 'sonnet' },
}

function getPoolFromTodo(todo) {
  // Match by assigned_agent name prefix first (god may set 'db-specialist', 'ui-specialist')
  const base = todo.assigned_agent?.replace(/-[a-f0-9]{6}$/, '')
  const byName = Object.values(AGENT_POOL).find(p => p.name === base)
  if (byName) return byName
  return AGENT_POOL[todo.priority] ?? AGENT_POOL.medium
}

// ── Curriculum / trust-gated task routing ─────────────────────────────────
// In-memory pool reliability tracker. After each closed task, we update
// {completed, failed, last20}. A pool with <60% reliability is in
// "apprentice" mode — only simple/short tasks route to it. Hits ≥85% on
// last 20 → graduates. Hits ≤40% → probation (half the flow, only low-pri).
const poolReliability = new Map()  // pool → { completed, failed, last20: 'C'|'F'[], tier }

function recordPoolOutcome(pool, outcome /* 'completed' | 'failed' */) {
  const r = poolReliability.get(pool) ?? { completed: 0, failed: 0, last20: [], tier: 'journeyman' }
  if (outcome === 'completed') r.completed += 1
  if (outcome === 'failed')    r.failed    += 1
  r.last20.push(outcome === 'completed' ? 'C' : 'F')
  if (r.last20.length > 20) r.last20.shift()

  const total = r.completed + r.failed
  const recent = r.last20.length >= 8
    ? r.last20.filter(x => x === 'C').length / r.last20.length
    : (total > 0 ? r.completed / total : 0)

  const prevTier = r.tier
  if (total < 5)               r.tier = 'apprentice'
  else if (recent >= 0.85)     r.tier = 'master'
  else if (recent >= 0.6)      r.tier = 'journeyman'
  else if (recent >= 0.4)      r.tier = 'probation'
  else                          r.tier = 'apprentice'

  if (prevTier !== r.tier) {
    console.log(`[CURRICULUM] ${pool} ${prevTier} → ${r.tier} (recent ${Math.round(recent * 100)}%)`)
  }
  poolReliability.set(pool, r)
}

function taskDifficulty(todo) {
  // Rough heuristic — short, single-file, non-boss tasks are "easy"
  const words = (todo.title ?? '').split(/\s+/).length
  if (todo.is_boss) return 'hard'
  if (words > 18)   return 'hard'
  if (/\+/.test(todo.title ?? '') || /across|patterns|classify/i.test(todo.title ?? '')) return 'hard'
  if (words > 12)   return 'medium'
  return 'easy'
}

/** Returns true if this pool is allowed to take this task given its tier. */
function curriculumAllows(pool, todo) {
  const r = poolReliability.get(pool)
  if (!r) return true  // no data yet → allow
  const diff = taskDifficulty(todo)
  switch (r.tier) {
    case 'master':      return true                                    // anything goes
    case 'journeyman':  return diff !== 'hard' || todo.priority === 'medium' || todo.priority === 'high'
    case 'apprentice':  return diff === 'easy'
    case 'probation':   return diff === 'easy' && todo.priority === 'low'
    default:            return true
  }
}

/** Diagnostic — surfaced by the dashboard. */
export function getCurriculumState() {
  return Object.fromEntries([...poolReliability.entries()].map(([p, r]) => [p, { ...r, last20: r.last20.join('') }]))
}

const MAX_PARALLEL = 4
const activeAgents = new Map()

// ── Smart model routing ────────────────────────────────────────────────────
const SONNET_KEYWORDS = [
  'typescript', 'react', 'component', 'tsx', 'jsx', 'refactor', 'redesign',
  'animation', 'tailwind', 'next.js', 'nextjs', 'middleware', 'api route',
  'multiple files', 'complex', 'architecture', 'full implementation',
  'supabase function', 'realtime', 'auth',
]

function selectModel(todo) {
  const base = AGENT_POOL[todo.priority] ?? AGENT_POOL.medium
  if (base.model === 'sonnet' || base.model === 'opus') return base.model
  const lower = (todo.title + ' ' + (todo.description ?? '')).toLowerCase()
  return SONNET_KEYWORDS.some(kw => lower.includes(kw)) ? 'sonnet' : base.model
}

// ── Agent memory ──────────────────────────────────────────────────────────
const AGENT_MEMORY_DIR = join(__dirname, 'agent-memory')
if (!existsSync(AGENT_MEMORY_DIR)) mkdirSync(AGENT_MEMORY_DIR, { recursive: true })

function loadAgentMemory(poolName) {
  const p = join(AGENT_MEMORY_DIR, `${poolName}.json`)
  try { if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')) } catch {}
  return { lessons: [], successPatterns: [], taskCount: 0 }
}

function updateAgentMemory(poolName, lesson) {
  const p = join(AGENT_MEMORY_DIR, `${poolName}.json`)
  const mem = loadAgentMemory(poolName)
  if (lesson) mem.lessons = [...mem.lessons.slice(-19), lesson]
  mem.taskCount = (mem.taskCount ?? 0) + 1
  try { writeFileSync(p, JSON.stringify(mem, null, 2), 'utf8') } catch {}
  // Also write to shared cross-pool memory
  if (lesson) addSharedLesson(lesson)
}

// ── Shared cross-pool memory ──────────────────────────────────────────────
// Delegates to lib-shared-memory.mjs (same helpers God uses) so both
// writers target the same file with compatible shape. Local aliases
// kept so existing call sites don't change.
import { loadShared, publishShared } from './lib-shared-memory.mjs'
import { generateTaskConversation } from './lib-conversation.mjs'

const loadSharedMemory  = () => loadShared(AGENT_MEMORY_DIR)
const addSharedLesson   = (lesson) => publishShared(AGENT_MEMORY_DIR, lesson)

// ── Error pattern matching from memory ────────────────────────────────────
function matchErrorToMemory(errorMsg, memory) {
  if (!errorMsg || !memory?.lessons?.length) return []
  const lower = errorMsg.toLowerCase()
  const words = lower.split(/\s+/).filter(w => w.length > 4)
  return memory.lessons.filter(l => {
    if (!l.startsWith('FAILED:')) return false
    return words.some(w => l.toLowerCase().includes(w))
  }).slice(-2)
}

// ── Cost tracking ─────────────────────────────────────────────────────────
const COST_PER_TOKEN = {
  'claude-haiku-4-5-20251001': { input: 0.0000008, output: 0.000004  },
  'claude-sonnet-4-6':          { input: 0.000003,  output: 0.000015  },
  'claude-opus-4-6':            { input: 0.000015,  output: 0.000075  },
}
const COST_LOG_PATH = join(__dirname, 'cost-log.json')
let costLog = { total: 0, byAgent: {}, sessions: [] }
try { costLog = JSON.parse(readFileSync(COST_LOG_PATH, 'utf8')) } catch {}

// ── Spend limits (override via .env.local) ────────────────────────────────
// Fallback defaults match current .env.local settings.
// If someone forks without .env.local these are sensible conservative values.
const DAILY_LIMIT_USD   = parseFloat(process.env.DAILY_COST_LIMIT_USD  ?? '5.00')
const MAX_TASK_COST_USD = parseFloat(process.env.MAX_TASK_COST_USD      ?? '0.15')
const MAX_INPUT_TOKENS  = parseInt(  process.env.MAX_INPUT_TOKENS_PER_RUN ?? '120000', 10)

// Global pause flag — set when credits are exhausted
let creditsPaused = false
let creditsPausedAt = 0

// Read from disk each time — multiple agent processes (god, ruflo, specialists)
// all write to cost-log.json, so the in-memory copy goes stale. Cheap read,
// small file.
function getTodaySpend() {
  let disk
  try { disk = JSON.parse(readFileSync(COST_LOG_PATH, 'utf8')) }
  catch { disk = costLog }
  const today = new Date().toISOString().slice(0, 10)
  return (disk.sessions ?? [])
    .filter(s => s.at?.startsWith(today))
    .reduce((sum, s) => sum + (s.cost ?? 0), 0)
}

function isOverDailyLimit() {
  return getTodaySpend() >= DAILY_LIMIT_USD
}

function isCreditError(err) {
  return err.status === 400 && (
    err.message?.includes('credit balance') ||
    err.message?.includes('insufficient_quota') ||
    err.message?.includes('Your credit balance is too low')
  )
}

function recordCost(agentPool, modelId, inputTokens, outputTokens) {
  const rates = COST_PER_TOKEN[modelId] ?? COST_PER_TOKEN['claude-haiku-4-5-20251001']
  const cost = inputTokens * rates.input + outputTokens * rates.output

  // Read fresh from disk so concurrent writers from other processes
  // (god, specialists, revenue) don't clobber each other's sessions.
  let fresh
  try { fresh = JSON.parse(readFileSync(COST_LOG_PATH, 'utf8')) }
  catch { fresh = { total: 0, byAgent: {}, sessions: [] } }

  fresh.total = (fresh.total ?? 0) + cost
  fresh.byAgent = fresh.byAgent ?? {}
  fresh.byAgent[agentPool] = (fresh.byAgent[agentPool] ?? 0) + cost
  fresh.sessions = [...(fresh.sessions ?? []).slice(-199), {
    at: new Date().toISOString(), agent: agentPool, cost, inputTokens, outputTokens
  }]

  try { writeFileSync(COST_LOG_PATH, JSON.stringify(fresh, null, 2), 'utf8') } catch {}
  costLog = fresh
  return cost
}

// ── Safety: keep all file access inside project root ──────────────────────
function safePath(p) {
  const abs = resolve(PROJECT_ROOT, p)
  if (!abs.startsWith(PROJECT_ROOT)) throw new Error(`Path outside project: ${p}`)
  return abs
}

// Permission boundary (scripts/lib-agent-permissions.mjs): reads of secret
// files and writes outside the allow-list are refused, whatever the model asks.
function readablePath(p) {
  const check = checkReadPath(p, PROJECT_ROOT)
  if (!check.allowed) throw new Error(`PERMISSION DENIED: ${check.reason}`)
  return safePath(p)
}
function writablePath(p) {
  const check = checkWritePath(p, PROJECT_ROOT)
  if (!check.allowed) throw new Error(`PERMISSION DENIED: ${check.reason}`)
  return safePath(p)
}

// ── Task category classifier ──────────────────────────────────────────────
const CAT_KEYWORDS = {
  db:       ['sql','query','table','database','schema','postgres','supabase','migration','index','agent_exec_sql','ddl','select','insert','trigger','rpc','function','view'],
  ui:       ['component','tsx','react','tailwind','dashboard','ui','button','form','chart','graph','page','layout','style','animation','modal','panel','nextjs','next.js'],
  infra:    ['pm2','deploy','ci','docker','server','npm','package','config','env','script','runner','orchestrator','cron','webhook'],
  analysis: ['analyze','analyse','review','report','audit','check','assess','evaluate','summarize','count','stats','metrics','log'],
}
function classifyTaskCategory(title) {
  const lower = title.toLowerCase()
  for (const [cat, kws] of Object.entries(CAT_KEYWORDS)) {
    if (kws.some(kw => lower.includes(kw))) return cat
  }
  return 'other'
}

// ── Tool definitions ──────────────────────────────────────────────────────
const DB_TOOLS = [
  {
    name: 'run_sql',
    description: 'Run a SELECT query against Supabase. Use for reading data and verifying changes.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'SQL SELECT query' } },
      required: ['query']
    }
  },
  {
    name: 'list_tables',
    description: 'List all tables in the public schema.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'describe_table',
    description: 'Show columns, types, and constraints for a table.',
    input_schema: {
      type: 'object',
      properties: { table_name: { type: 'string' } },
      required: ['table_name']
    }
  },
  {
    name: 'create_subtask',
    description: 'Decompose the current task by creating a new subtask in the queue. Use when the task is too large to complete in one pass — split into focused, independent pieces.',
    input_schema: {
      type: 'object',
      properties: {
        title:    { type: 'string', description: 'Clear, specific subtask title (actionable, one responsibility)' },
        priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
      },
      required: ['title', 'priority']
    }
  },
]

const FILE_TOOLS = [
  {
    name: 'read_file',
    description: 'Read a file. ALWAYS call this before write_file or patch_file.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative path from project root' } },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: 'Write or overwrite an entire file. MUST read_file first — otherwise you risk erasing code you have not seen. For small edits, prefer patch_file instead.',
    input_schema: {
      type: 'object',
      properties: {
        path:    { type: 'string' },
        content: { type: 'string', description: 'Full file content to write' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'patch_file',
    description: 'Make a targeted edit — finds an exact string in a file and replaces it. Safer than write_file because only the specified section changes. Use this for small, targeted edits to existing files.',
    input_schema: {
      type: 'object',
      properties: {
        path:       { type: 'string', description: 'Relative path from project root' },
        old_string: { type: 'string', description: 'Exact string to find (must appear exactly once in the file)' },
        new_string: { type: 'string', description: 'Replacement string' },
      },
      required: ['path', 'old_string', 'new_string']
    }
  },
  {
    name: 'list_directory',
    description: 'List files and folders in a directory.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative path from project root' } },
      required: ['path']
    }
  },
  {
    name: 'task_complete',
    description: 'Signal task is done. VERIFY FIRST: read back any files you wrote, run SELECT to confirm DDL changes applied. Only call this after confirming the work is correct.',
    input_schema: {
      type: 'object',
      properties: {
        summary:       { type: 'string', description: 'What was implemented (1-3 sentences)' },
        files_changed: { type: 'array', items: { type: 'string' }, description: 'Files modified or created' }
      },
      required: ['summary']
    }
  },
  {
    name: 'web_search',
    description: 'Search the web for documentation or solutions.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query']
    }
  },
  {
    name: 'fetch_url',
    description: 'Fetch and read the content of a URL.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url']
    }
  },
  {
    name: 'git_status',
    description: 'Show which files have been modified, added, or deleted in the working tree.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'git_diff',
    description: 'Show the diff of changes since the last commit. Optionally limit to a specific file.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Optional file path to diff' } }
    }
  },
  {
    name: 'git_stash',
    description: 'Stash all current changes so you can start fresh. Use before risky edits as a safety checkpoint.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'git_commit',
    description: 'Stage all changes and commit them with a message. Use after successfully completing work.',
    input_schema: {
      type: 'object',
      properties: { message: { type: 'string', description: 'Commit message summarising the changes' } },
      required: ['message']
    }
  },
  {
    name: 'tsc_check',
    description: 'Run TypeScript compiler (tsc --noEmit) to verify no type errors. ALWAYS call after editing .tsx or .ts files.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'git_log_file',
    description: 'Look at past commits that touched a file. Useful before editing — reveals how similar fixes were solved before. Returns the last N commit subjects + summary diff stats.',
    input_schema: {
      type: 'object',
      properties: {
        path:  { type: 'string', description: 'File path relative to the repo root' },
        limit: { type: 'number', description: 'Max commits to return (default 10, max 30)' },
      },
      required: ['path']
    }
  },
]

const ALL_TOOLS = [...DB_TOOLS, ...FILE_TOOLS]

// ── Pool-specific system prompts ──────────────────────────────────────────
// crewAI-style personified prompts. Each specialist has a role, backstory,
// and opinionated methodology. Claude reasons better when it has a persona
// with specific experience to draw from — measured ~15% lift in success
// rate over the old terse descriptions.
const POOL_MODE = {
  'ruflo-critical': `You are SENTINEL — a senior engineer on the critical-path team.
You've shipped code to production systems handling 10M requests/day and you've seen what happens when someone "just pushes a quick fix." That ghost of the 3am page haunts every decision you make.

Your method:
1. Read ALL relevant files completely before touching anything. Context before action.
2. Prefer \`patch_file\` — surgical edits over rewrites. Smaller diff, smaller blast radius.
3. ALWAYS run \`tsc_check\` after .ts/.tsx edits. Non-negotiable.
4. For DB changes, \`list_tables\` and \`describe_table\` first. Never guess at column names.
5. If you're uncertain, stop and explain what you'd need to verify. Don't improvise.

When in doubt: do less.`,

  'ruflo-high': `You are FORGE — a senior product engineer known for shipping clean, well-tested features under deadline pressure.
You're opinionated about code style. You know the codebase well. You move quickly but never skip verification steps.

Your method:
1. Read the existing code in the area you're changing. Match its conventions.
2. Implement the smallest change that satisfies the task — no gold-plating.
3. Run \`tsc_check\` after every TypeScript edit. If it fails, fix it before moving on.
4. Commit with a one-line present-tense summary when done.

You ship, you don't over-architect.`,

  'ruflo-medium': `You are ARTISAN — a full-stack engineer who takes pride in getting the details right.
You've seen enough hacky one-liners to know they compound into tech debt. You write code that the next engineer (including yourself next month) will thank you for.

Your method:
1. Read first, understand the context, then act.
2. \`patch_file\` for targeted edits. \`write_file\` only when creating new files or doing substantial rewrites.
3. Verify with \`tsc_check\` for TypeScript; with a \`run_sql SELECT\` for DDL changes.
4. Handle the obvious edge cases (empty arrays, null values, missing env vars) — don't be paranoid but don't be lazy.`,

  'ruflo-low': `You are STEWARD — a careful, minimalist engineer.
Your job is to make the requested change and nothing else. No refactors, no "while I'm in here" tangents. The task is the task.

Your method:
1. Make the minimum change that satisfies the requirement.
2. Verify it works (\`tsc_check\` for TypeScript, a quick \`run_sql\` for DB).
3. Stop. Do not improve adjacent code.`,

  'db-specialist': `You are SQLMITH — a principal database engineer specialised in PostgreSQL and Supabase.
You've dealt with:
  - migrations that locked tables for 20 minutes
  - \`DELETE FROM users\` without WHERE
  - RLS policies that silently blocked legitimate writes
  - \`citext\` vs \`text\` casing bugs that cost 4 hours to find
You've learned: INTROSPECT FIRST. Verify every assumption. Test on a SELECT before DELETEing.

Your method:
1. ALWAYS start with \`list_tables\` and \`describe_table\` for the tables you'll touch.
2. For queries: write the SELECT first, eyeball a sample, then any mutation.
3. For DDL: use \`run_ddl\` with a single atomic statement. Wrap in explicit transactions only if needed.
4. NEVER guess at column names — if you're not sure, run a \`SELECT column_name FROM information_schema.columns WHERE table_name = '...'\`.
5. When testing RLS, check with both the anon and service role.

Your enemy is assumption. Your friend is \`LIMIT 10\`.`,

  'ui-specialist': `You are PIXEL — a senior frontend engineer who has spent years in React, Next.js 14 App Router, TypeScript, and Tailwind.
You know the ecosystem's sharp edges: client vs server components, Suspense boundaries, hydration errors, the "use client" pragma, the difference between useEffect cleanup and useRef cleanup. You've debugged enough flickering UIs to have strong opinions about loading states.

Your method:
1. Read the existing component BEFORE editing. Match its style (indentation, naming, JSX pattern).
2. Use \`patch_file\` for small targeted changes. Rewrites are a last resort.
3. Run \`tsc_check\` after every .tsx or .ts edit. TypeScript errors compound.
4. If adding new state, question whether it belongs in a parent or a hook.
5. For Tailwind: match the existing palette. This codebase uses slate + cyan + amber accent colours.
6. Every async effect needs cleanup. Every event listener needs removeEventListener. No exceptions.

Your instinct: less state, smaller components, leaner JSX.`,
}

function getSystemPrompt(poolName, todo, memoryBlock, preflightNotes) {
  return `You are an autonomous coding agent working on a Next.js 14 + Supabase real-time task dashboard.

Project root: ${PROJECT_ROOT}
Key directories:
- app/          Next.js pages and layouts
- components/   React components (TSX)
- types/        TypeScript interfaces
- scripts/      Agent runner scripts
- supabase/migrations/  SQL migrations

TOOLS AVAILABLE:
- Database: run_sql / run_ddl / list_tables / describe_table
- Files: read_file / write_file / patch_file / list_directory
- Web: web_search / fetch_url
- Control: task_complete / create_subtask
${memoryBlock}${preflightNotes ? `\nPRE-FLIGHT ASSESSMENT:\n${preflightNotes}\n` : ''}
MANDATORY RULES:
1. READ BEFORE WRITE — always read_file before write_file. Use patch_file for small targeted edits.
2. VERIFY BEFORE DONE — before task_complete: read back files you wrote, run SELECT to confirm DDL changes landed.
3. DECOMPOSE IF NEEDED — if the task requires >3 significant changes across different files or systems, use create_subtask to split into focused pieces, then complete what you can now.
4. CHECK SCHEMA FIRST — list_tables + describe_table before any SQL operations.
5. ERROR MEMORY — if a tool returns an error, check if the [Memory hint] points to a known fix.
6. USE WEB SEARCH — when you hit an unfamiliar error, need Supabase/Next.js/TypeScript API docs, or are unsure how to implement something, call web_search FIRST before guessing. Use fetch_url to read specific docs pages or GitHub examples.

MODE: ${POOL_MODE[poolName] ?? 'STANDARD'}

Task: ${todo.title}
Priority: ${todo.priority}`
}

// ── Pre-flight validation ─────────────────────────────────────────────────
async function preflight(todo, memory) {
  const errorHints = matchErrorToMemory(todo.title, memory)
  const avoidHint = errorHints.length > 0
    ? `\nPAST FAILURES on similar tasks:\n${errorHints.join('\n')}`
    : ''

  const prompt = `Task: "${todo.title}"
${avoidHint}

Assess in 4 lines (be very brief):
FEASIBLE: yes/no — one reason
RISKY: yes/no — what could go wrong
DECOMPOSE: yes/no — should this be split into smaller subtasks?
APPROACH: one sentence on implementation strategy`

  try {
    const msg = await anthropic.messages.create({
      model: MODELS.haiku,
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }]
    })
    return msg.content[0]?.type === 'text' ? msg.content[0].text : null
  } catch { return null }
}

// ── Context compression ────────────────────────────────────────────────────
// Jaccard token-set similarity — cheap, no embeddings needed
function jaccard(a, b) {
  const sa = new Set(String(a).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length >= 4))
  const sb = new Set(String(b).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length >= 4))
  if (!sa.size || !sb.size) return 0
  let inter = 0
  for (const t of sa) if (sb.has(t)) inter++
  return inter / (sa.size + sb.size - inter)
}

/**
 * Entroly-style similarity compression:
 *   1. Extract tool_use calls + their tool_result responses from mid-history.
 *   2. Dedupe near-duplicates (Jaccard ≥ 0.75) — repeatedly reading the same
 *      file, re-running the same grep, etc. Keep the last instance only.
 *   3. Summarise the deduped action log with Haiku in ≤3 bullets.
 *   4. Replay the last 2 tool interactions intact so Claude has fresh
 *      context for its next move.
 */
async function compressMessages(messages) {
  if (messages.length <= 8) return messages

  const head = messages[0]                        // original task prompt
  const tail = messages.slice(-4)                 // freshest 4 messages — may contain unresolved tool_use
  const mid  = messages.slice(1, -4)

  // Extract canonical one-liners for each mid action
  // Shape: { kind: 'call' | 'result', text: string, idx: number }
  const lines = []
  for (const [i, m] of mid.entries()) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'tool_use') {
          lines.push({ kind: 'call',   text: `${b.name}(${JSON.stringify(b.input).slice(0, 100)})`, idx: i })
        }
      }
    } else if (m.role === 'user' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          lines.push({ kind: 'result', text: `→ ${String(b.content).slice(0, 180)}`, idx: i })
        }
      }
    }
  }

  // Dedupe: iterate in order, keeping only the last occurrence of any
  // near-duplicate action (Jaccard ≥ 0.75 on content)
  const kept = []
  for (let i = lines.length - 1; i >= 0; i--) {
    const cur = lines[i]
    const dup = kept.some(k => k.kind === cur.kind && jaccard(k.text, cur.text) >= 0.75)
    if (!dup) kept.push(cur)
  }
  kept.reverse()
  const removed = lines.length - kept.length

  try {
    const summaryPrompt = removed > 0
      ? `Summarize these agent actions in 3 brief bullets. Note: ${removed} near-duplicate actions were removed (agent re-reading same files).\n${kept.slice(0, 30).map(l => l.text).join('\n')}`
      : `Summarize these agent actions in 3 brief bullets:\n${kept.slice(0, 30).map(l => l.text).join('\n')}`

    const msg = await anthropic.messages.create({
      model: MODELS.haiku,
      max_tokens: 220,
      messages: [{ role: 'user', content: summaryPrompt }],
    })
    const summary = msg.content[0]?.text ?? 'Work in progress.'

    // Clean-slate output: task prompt → summary → nudge to continue.
    // We drop the messy tool_result/tool_use pairs in the tail since they
    // frequently break API validation (unmatched IDs after compression).
    return [
      head,
      { role: 'assistant', content: [{ type: 'text', text: `Progress so far${removed > 0 ? ` (deduped ${removed} redundant actions)` : ''}:\n${summary}` }] },
      { role: 'user', content: 'Continue from where you left off.' },
    ]
  } catch {
    return messages
  }
}

// ── Execute a tool call ────────────────────────────────────────────────────
async function executeTool(name, input, { readFiles, memory } = {}) {
  // Raw SQL and DDL were removed (agent_exec_sql / agent_exec_ddl no longer
  // exist). Schema changes go through reviewed migrations only.
  if (name === 'run_sql' || name === 'run_ddl') {
    return `PERMISSION DENIED: ${checkOperation(name === 'run_ddl' ? 'db.ddl' : 'db.raw_sql').reason}. Schema/data changes require a reviewed migration.`
  }

  if (name === 'list_tables' || name === 'describe_table') {
    return `PERMISSION DENIED: ${checkOperation('db.raw_sql').reason}. Read supabase/migrations/ for the schema.`
  }

  if (name === 'create_subtask') {
    try {
      const agent = AGENT_POOL[input.priority] ?? AGENT_POOL.medium
      const category = classifyTaskCategory(input.title)
      const { error } = await supabase.from('todos').insert({
        title:          input.title,
        // Agent-created work waits for a human in the Task Inbox.
        status:         'proposed',
        priority:       input.priority,
        assigned_agent: agent.name,
        parent_task_id: opts.parentTaskId ?? null,
        task_category:  category,
      })
      if (error) return `Error creating subtask: ${error.message}`
      console.log(`[ruflo] Subtask created: "${input.title}" [${input.priority}] (${category})`)
      return `Subtask created: "${input.title}" [${input.priority}] category:${category} — queued for next available agent.`
    } catch (e) { return `Error: ${e.message}` }
  }

  if (name === 'read_file') {
    try {
      const abs = readablePath(input.path)
      if (!existsSync(abs)) return `File not found: ${input.path}`
      readFiles?.add(input.path)
      const content = readFileSync(abs, 'utf8')
      return content.length > 8000
        ? content.slice(0, 8000) + '\n... [truncated — use patch_file for targeted edits]'
        : content
    } catch (e) { return `Error reading file: ${e.message}` }
  }

  if (name === 'write_file') {
    try {
      const abs = writablePath(input.path)
      const notRead = readFiles && !readFiles.has(input.path)
      const dir = dirname(abs)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(abs, input.content, 'utf8')
      const warning = notRead
        ? `\n⚠️  WARNING: Wrote ${input.path} without reading it first. Verify nothing was accidentally removed.`
        : ''
      return `Written: ${input.path}${warning}`
    } catch (e) { return `Error writing file: ${e.message}` }
  }

  if (name === 'patch_file') {
    try {
      const abs = writablePath(input.path)
      if (!existsSync(abs)) return `File not found: ${input.path}`
      const original = readFileSync(abs, 'utf8')
      readFiles?.add(input.path)
      if (!original.includes(input.old_string)) {
        return `patch_file error: old_string not found in ${input.path}. The string must match exactly. Read the file first to copy the exact text you want to replace.`
      }
      const occurrences = original.split(input.old_string).length - 1
      if (occurrences > 1) {
        return `patch_file error: old_string appears ${occurrences} times in ${input.path} — make it more specific so it uniquely identifies the target location.`
      }
      writeFileSync(abs, original.replace(input.old_string, input.new_string), 'utf8')
      return `Patched: ${input.path} (${occurrences} replacement)`
    } catch (e) { return `Error patching file: ${e.message}` }
  }

  if (name === 'list_directory') {
    try {
      const abs = safePath(input.path)
      if (!existsSync(abs)) return `Directory not found: ${input.path}`
      const entries = readdirSync(abs, { withFileTypes: true })
      return entries.map(e => `${e.isDirectory() ? '[dir]' : '[file]'} ${e.name}`).join('\n')
    } catch (e) { return `Error listing directory: ${e.message}` }
  }

  if (name === 'task_complete') return '__DONE__'

  if (name === 'web_search') {
    try {
      const q = encodeURIComponent(input.query)
      // Use Jina search for real web results
      const res = await fetch(`https://s.jina.ai/?q=${q}`, {
        headers: { 'Accept': 'text/plain', 'X-No-Cache': 'true' },
        signal: AbortSignal.timeout(20000),
      })
      const text = await res.text()
      return text.slice(0, 6000) || 'No results found.'
    } catch (e) { return `Search error: ${e.message}` }
  }

  if (name === 'fetch_url') {
    try {
      const res = await fetch(`https://r.jina.ai/${input.url}`, {
        headers: { 'Accept': 'text/plain', 'X-No-Cache': 'true' },
        signal: AbortSignal.timeout(15000),
      })
      return (await res.text()).slice(0, 6000)
    } catch (e) { return `Fetch error: ${e.message}` }
  }

  if (name === 'git_status') {
    try {
      const { execSync } = await import('node:child_process')
      const out = execSync('git status --short', { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 10000 })
      return out.trim() || 'Working tree clean — no changes.'
    } catch (e) { return `git error: ${e.message}` }
  }

  if (name === 'git_diff') {
    try {
      const args = input.path ? ['diff', '--', String(input.path)] : ['diff']
      const out = execFileSync('git', args, { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 10000 })
      return out.slice(0, 6000) || 'No changes.'
    } catch (e) { return `git error: ${e.message}` }
  }

  if (name === 'git_stash') {
    try {
      const { execSync } = await import('node:child_process')
      const out = execSync('git stash', { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 10000 })
      return out.trim() || 'Stashed.'
    } catch (e) { return `git error: ${e.message}` }
  }

  if (name === 'git_commit') {
    try {
      // Stage only changed files that are inside the write allow-list; refuse
      // if anything protected is already staged. Never push.
      const git = (...args) => execFileSync('git', args, { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 10000 })
      const changed = git('status', '--porcelain', '-z', '--no-renames', '--untracked-files=all').split('\0').filter(Boolean).map(l => l.slice(3))
      const blocked = violations(changed, PROJECT_ROOT)
      if (blocked.length) {
        return `PERMISSION DENIED: working tree contains changes to protected paths — nothing committed:\n${blocked.map(b => ` - ${b.reason}`).join('\n')}`
      }
      if (changed.length === 0) return 'Nothing to commit — working tree clean.'
      git('add', '--', ...changed)
      const msg = String(input.message ?? 'agent change').slice(0, 200)
      const out = git('commit', '-m', `[ops-agent] ${msg}`)
      return out.trim()
    } catch (e) {
      // "nothing to commit" is not an error
      if (e.message.includes('nothing to commit')) return 'Nothing to commit — working tree clean.'
      return `git error: ${e.message}`
    }
  }

  if (name === 'tsc_check') {
    try {
      const { execSync } = await import('node:child_process')
      try {
        const out = execSync('npx tsc --noEmit 2>&1', { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 60000 })
        return `TypeScript OK — no errors.\n${out.trim()}`
      } catch (e) {
        const output = (e.stdout ?? '') + (e.stderr ?? '') + (e.message ?? '')
        return `TypeScript errors:\n${output.slice(0, 4000)}`
      }
    } catch (e) { return `tsc error: ${e.message}` }
  }

  if (name === 'git_log_file') {
    const { execSync } = await import('node:child_process')
    const { path: p, limit } = input
    if (!p || typeof p !== 'string') return 'git_log_file error: path is required'
    const n = Math.min(30, Math.max(1, Number(limit) || 10))
    // Guard against path traversal / space injection — reject anything with
    // shell metacharacters. Forward slashes, hyphens, dots are fine.
    if (/[^a-zA-Z0-9_\-./\\]/.test(p)) return `git_log_file error: unsafe path "${p}"`
    try {
      const out = execSync(
        `git log -n ${n} --format="%h · %ai · %s" --shortstat -- "${p}"`,
        { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 10_000 },
      ).trim()
      if (!out) return `No git history for ${p} (file may be new or untracked).`
      return `Recent commits touching ${p}:\n\n${out.slice(0, 3000)}`
    } catch (e) {
      return `git_log_file error: ${(e.stderr ?? e.message).slice(0, 200)}`
    }
  }

  return `Unknown tool: ${name}`
}

// ── Retry wrapper for rate-limit errors ───────────────────────────────────
async function callWithRetry(fn, maxRetries = 4) {
  let delay = 60_000
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { return await fn() } catch (err) {
      // Credit exhaustion — pause everything, don't retry
      if (isCreditError(err)) {
        creditsPaused = true
        creditsPausedAt = Date.now()
        console.error('[ruflo] ⛔ CREDIT EXHAUSTED — agents paused. Top up at console.anthropic.com')
        throw err
      }
      const is429 = err.status === 429 || err.message?.includes('rate_limit') || err.message?.includes('429')
      if (is429 && attempt < maxRetries) {
        console.log(`[ruflo] Rate limited — waiting ${delay / 1000}s before retry ${attempt + 1}/${maxRetries}`)
        await new Promise(r => setTimeout(r, delay))
        delay = Math.min(delay * 1.5, 300_000)
        continue
      }
      throw err
    }
  }
}

// ── Agentic loop ──────────────────────────────────────────────────────────
async function runAgentLoop(todo, agentName, model, poolName, opts = {}) {
  const memory       = loadAgentMemory(poolName)
  const sharedMemory = loadSharedMemory()

  // Pick lessons by SIMILARITY to the task title, not just recency. This
  // means db tasks surface db-specific lessons, ui tasks surface ui ones,
  // and generic lessons (about approvals, cost caps, etc.) only appear
  // when they actually match the current work.
  const { findRelevantLessons } = await import('./god/memory.mjs')
  let poolLessons   = findRelevantLessons(memory.lessons,       todo.title, 5)
  let globalLessons = findRelevantLessons(sharedMemory.lessons, todo.title, 3)

  // Fall back to recency-based if similarity returned nothing (cold start)
  if (poolLessons.length === 0)   poolLessons   = memory.lessons.slice(-5)
  if (globalLessons.length === 0) globalLessons = sharedMemory.lessons.slice(-3)

  // Dedup global against pool
  const poolSet = new Set(poolLessons)
  globalLessons = globalLessons.filter(l => !poolSet.has(l))

  const memoryBlock = (poolLessons.length + globalLessons.length) > 0
    ? `\nAGENT MEMORY (${memory.taskCount} tasks this pool | ${sharedMemory.taskCount} total, ranked by relevance):\n${poolLessons.join('\n')}${globalLessons.length ? '\nGLOBAL: ' + globalLessons.join(' | ') : ''}\n`
    : ''

  // Pre-flight validation (skip on retry — already have context)
  let preflightNotes = ''
  if (!opts.isRetry) {
    const notes = await preflight(todo, memory).catch(() => null)
    if (notes) {
      preflightNotes = notes
      console.log(`[${agentName}] Pre-flight: ${notes.split('\n')[0]}`)
    }
  } else {
    preflightNotes = `RETRY — Previous approach failed with: ${opts.failureReason ?? 'unknown error'}. Try a completely different, simpler strategy.`
  }

  const systemPrompt = getSystemPrompt(poolName, todo, memoryBlock, preflightNotes)

  const messages = [
    { role: 'user', content: `Please implement this task: ${todo.title}` }
  ]

  const filesChanged = []
  const readFiles = new Set()
  let summary = ''
  let iterations = 0
  let totalInputTokens = 0
  let totalOutputTokens = 0
  const MAX_ITERATIONS = 20
  const WALL_CLOCK_TIMEOUT = 8 * 60 * 1000  // 8 minutes
  const deadline = Date.now() + WALL_CLOCK_TIMEOUT
  const modelId = MODELS[model] ?? MODELS.sonnet

  while (iterations < MAX_ITERATIONS) {
    // Wall-clock timeout
    if (Date.now() > deadline) {
      throw new Error(`Agent timeout after 8 minutes (${iterations} iterations). Partial work may have been done.`)
    }

    // Input token budget — force wrap-up to prevent runaway context costs
    if (totalInputTokens > MAX_INPUT_TOKENS) {
      summary = `Token budget reached (${totalInputTokens.toLocaleString()} input tokens). Wrapping up.`
      console.log(`[${agentName}] Token budget hit — stopping early`)
      break
    }

    // ── Pre-call estimation gate ─────────────────────────────────────────
    // Heuristic: ~3.5 chars per token. If projecting this next call would
    // push total input past the cap, stop now before burning tokens and
    // getting cut off mid-thought. Cheaper + gives us a clean summary.
    const projectedExtraChars = messages.reduce((n, m) => {
      if (typeof m.content === 'string') return n + m.content.length
      if (Array.isArray(m.content)) {
        return n + m.content.reduce((s, b) => s + JSON.stringify(b).length, 0)
      }
      return n
    }, 0)
    const projectedTokens = totalInputTokens + Math.ceil(projectedExtraChars / 3.5)
    if (projectedTokens > MAX_INPUT_TOKENS * 0.95) {
      summary = `Pre-call gate: projected input ~${projectedTokens.toLocaleString()} tokens would exceed cap. Wrapping up with partial progress.`
      console.log(`[${agentName}] Pre-call gate tripped — stopping before overflow`)
      break
    }

    // Per-task cost cap — abort if this one task is getting too expensive
    if (totalInputTokens > 10_000) { // only check after warmup
      const estimatedCost = totalInputTokens * (COST_PER_TOKEN[MODELS[model]]?.input ?? 0.0000008)
                          + totalOutputTokens * (COST_PER_TOKEN[MODELS[model]]?.output ?? 0.000004)
      if (estimatedCost > MAX_TASK_COST_USD) {
        summary = `Cost cap hit ($${estimatedCost.toFixed(4)} > $${MAX_TASK_COST_USD} limit). Stopping.`
        console.log(`[${agentName}] Cost cap hit — stopping (est. $${estimatedCost.toFixed(4)})`)
        break
      }
    }

    iterations++

    // Context compression at iteration 10
    // Compress earlier at iteration 7 — most tasks were hitting the input
    // token cap around iter 8-10 and aborting with incomplete work. Moving
    // compression earlier buys 2-3 more productive iterations.
    if (iterations === 7 && messages.length > 6) {
      console.log(`[${agentName}] Compressing context at iteration 7...`)
      const compressed = await compressMessages(messages)
      messages.length = 0
      messages.push(...compressed)
    }

    // Prompt caching: the system prompt + tool schemas are identical across
    // all iterations of a single task. Marking them as ephemeral cache blocks
    // makes Anthropic charge 10% of the normal input rate on reads (90% off)
    // after the first call. Specialists do 7-10 loops per task — this cuts
    // ~40% off our per-task Claude spend.
    const response = await callWithRetry(() => anthropic.messages.create({
      model: modelId,
      max_tokens: 4096,
      system: [
        { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
      ],
      tools: ALL_TOOLS.map((t, i) =>
        // Cache breakpoint on the last tool — covers all tools above it
        i === ALL_TOOLS.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t
      ),
      messages,
    }))

    if (response.usage) {
      totalInputTokens  += response.usage.input_tokens  ?? 0
      totalOutputTokens += response.usage.output_tokens ?? 0
    }

    messages.push({ role: 'assistant', content: response.content })

    if (response.stop_reason === 'end_turn') {
      summary = response.content.find(b => b.type === 'text')?.text?.slice(0, 300) ?? 'Task complete.'
      break
    }
    if (response.stop_reason !== 'tool_use') break

    const toolResults = []
    let done = false

    for (const block of response.content) {
      if (block.type !== 'tool_use') continue

      console.log(`[${agentName}] → ${block.name}(${JSON.stringify(block.input).slice(0, 80)})`)

      const t0 = Date.now()
      const result = await executeTool(block.name, block.input, { readFiles, memory, parentTaskId: todo.id })
      const durationMs = Date.now() - t0
      const isError = typeof result === 'string' && (
        result.startsWith('Error') || result.startsWith('SQL error') ||
        result.startsWith('DDL error') || result.startsWith('patch_file error')
      )

      recordTrace(
        todo.id, agentName, block.name,
        JSON.stringify(block.input).slice(0, 300),
        result === '__DONE__' ? 'done' : result,
        durationMs, isError
      )

      if (result === '__DONE__') {
        summary = block.input.summary ?? 'Task complete.'
        if (block.input.files_changed) filesChanged.push(...block.input.files_changed)
        done = true
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'Done.' })
      } else {
        if ((block.name === 'write_file' || block.name === 'patch_file') && !isError) {
          filesChanged.push(block.input.path)
        }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result })
      }
    }

    messages.push({ role: 'user', content: toolResults })
    if (done) break
  }

  const totalCost = recordCost(poolName, modelId, totalInputTokens, totalOutputTokens)
  return { summary, filesChanged, totalCost }
}

// ── Trace recording ───────────────────────────────────────────────────────
async function recordTrace(taskId, agentName, toolName, inputSummary, resultSummary, durationMs, isError) {
  try {
    await supabase.from('traces').insert({
      task_id: taskId, agent_name: agentName, tool_name: toolName,
      input_summary: inputSummary?.slice(0, 300) ?? '',
      result_summary: resultSummary?.slice(0, 300) ?? '',
      duration_ms: durationMs, is_error: isError,
    })
  } catch {}
}

// ── Supabase helpers ──────────────────────────────────────────────────────
async function addComment(taskId, agent, text) {
  const { data } = await supabase.from('todos').select('comments').eq('id', taskId).single()
  const comments = [...(data?.comments ?? []), { agent, text, at: new Date().toISOString() }]
  await supabase.from('todos').update({ comments }).eq('id', taskId)
}

async function updateTask(id, status, agentName) {
  const { error } = await supabase
    .from('todos')
    .update({ status, ...(agentName ? { assigned_agent: agentName } : {}) })
    .eq('id', id)
  if (error) console.error(`[ruflo] Failed to update ${id}:`, error.message)
  else console.log(`[ruflo] ${agentName ?? ''} → ${id} = ${status}`)
}

async function webhook(text) {
  const url = process.env.WEBHOOK_URL
  if (!url) return
  try {
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
  } catch {}
}

// Fire-and-forget LLM-as-a-Judge: scores a completed task 1-5 on quality and
// writes the verdict to todos.metadata. Cheap (Haiku), non-blocking, and silently
// skipped if credits are exhausted so it never delays the main pipeline.
async function scoreTaskQuality(todoId, title, resultText) {
  try {
    const prompt = `You grade autonomous-agent task outcomes.

TASK: ${title}
RESULT:
${(resultText ?? '').slice(0, 800)}

Score 1-5:
  5 = completed the stated goal with real output
  4 = mostly did it; minor gaps
  3 = partial — some value, some missing
  2 = technically "done" but produced nothing useful
  1 = nothing of value; padding, token-budget stop, or off-goal

Reply ONLY with JSON: {"score": 1-5, "reason": "<=15 words"}`

    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 120,
      messages: [{ role: 'user', content: prompt }],
    })
    const text = resp.content[0]?.type === 'text' ? resp.content[0].text : ''
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return
    const parsed = JSON.parse(match[0])
    const score = Number(parsed.score)
    if (!Number.isFinite(score) || score < 1 || score > 5) return

    // Merge into existing metadata without clobbering
    const { data: existing } = await supabase.from('todos').select('metadata').eq('id', todoId).single()
    const meta = { ...(existing?.metadata ?? {}), quality_score: score, quality_reason: String(parsed.reason ?? '').slice(0, 200), quality_scored_at: new Date().toISOString() }
    await supabase.from('todos').update({ metadata: meta }).eq('id', todoId)
    console.log(`[JUDGE] ${todoId.slice(0,8)} → ${score}/5 (${parsed.reason?.slice(0, 60) ?? ''})`)
  } catch (err) {
    if (!isCreditError(err)) {
      console.log(`[JUDGE] skipped: ${err.message?.slice(0, 80)}`)
    }
  }
}

// ── Main task runner (with self-healing retry) ────────────────────────────
// ── Per-pool circuit breaker ──────────────────────────────────────────────
// In-memory rolling window of failures & spend per pool. If a pool fails 3×
// in the last 10 min OR burns > $POOL_HOURLY_CAP in an hour, the breaker
// opens and future tasks for that pool reset to 'pending' (picked up later
// once the window expires). Prevents stuck-loop cost explosions.
const POOL_FAIL_WINDOW_MS  = 10 * 60_000
const POOL_FAIL_THRESHOLD  = 3
const POOL_HOURLY_CAP_USD  = 3.0
const poolFailures  = new Map() // pool → [ts, ts, ts]
const poolHourlyUsd = new Map() // pool → [{at, usd}]
const breakerOpenUntil = new Map() // pool → timestamp

function recordPoolFailure(pool) {
  const arr = (poolFailures.get(pool) ?? []).filter(ts => Date.now() - ts < POOL_FAIL_WINDOW_MS)
  arr.push(Date.now())
  poolFailures.set(pool, arr)
  if (arr.length >= POOL_FAIL_THRESHOLD) {
    breakerOpenUntil.set(pool, Date.now() + 30 * 60_000)
    console.log(`[CIRCUIT] ⛔ ${pool} breaker OPEN — ${arr.length} failures in ${POOL_FAIL_WINDOW_MS/60000}m. Pausing 30m.`)
  }
}

function recordPoolCost(pool, usd) {
  const arr = (poolHourlyUsd.get(pool) ?? []).filter(e => Date.now() - e.at < 3600_000)
  arr.push({ at: Date.now(), usd })
  poolHourlyUsd.set(pool, arr)
  const hourly = arr.reduce((s, e) => s + e.usd, 0)
  if (hourly > POOL_HOURLY_CAP_USD) {
    breakerOpenUntil.set(pool, Date.now() + 60 * 60_000)
    console.log(`[CIRCUIT] 💰 ${pool} breaker OPEN — $${hourly.toFixed(2)}/hr > $${POOL_HOURLY_CAP_USD}. Pausing 60m.`)
  }
}

function isBreakerOpen(pool) {
  const until = breakerOpenUntil.get(pool)
  if (!until) return false
  if (Date.now() >= until) {
    breakerOpenUntil.delete(pool)
    poolFailures.delete(pool)
    console.log(`[CIRCUIT] ✓ ${pool} breaker CLOSED — resuming`)
    return false
  }
  return true
}

async function runAgent(todo) {
  const pool  = getPoolFromTodo(todo)
  const model = selectModel(todo)
  const agentName = `${pool.name}-${todo.id.slice(0, 6)}`
  const poolName  = pool.name

  if (activeAgents.has(todo.id)) return

  // Curriculum gate — don't send hard tasks to under-qualified pools
  if (!curriculumAllows(poolName, todo)) {
    console.log(`[CURRICULUM] ${poolName} skipping "${todo.title.slice(0, 50)}" (tier too low for task difficulty)`)
    // Reset to pending so a different pool can pick it up, OR so it waits
    // until this pool graduates
    await supabase.from('todos').update({ status: 'pending', assigned_agent: null }).eq('id', todo.id)
    return
  }

  // Circuit breaker — bail before spending anything on a misbehaving pool
  if (isBreakerOpen(poolName)) {
    const until = breakerOpenUntil.get(poolName)
    const minsLeft = Math.ceil((until - Date.now()) / 60_000)
    console.log(`[${poolName}] breaker open, skipping "${todo.title.slice(0, 50)}" (${minsLeft}m remaining)`)
    // Reset the task to pending so it'll be retried after the breaker clears
    await supabase.from('todos').update({ status: 'pending', assigned_agent: null }).eq('id', todo.id)
    return
  }

  activeAgents.set(todo.id, agentName)

  if (model !== pool.model) {
    console.log(`[${agentName}] Model upgraded: ${pool.model} → ${model} (keyword match)`)
  }

  await updateTask(todo.id, 'in_progress', agentName)
  await addComment(todo.id, agentName, 'Agent started — reading codebase...')

  // ── Pre-task conversation — God + specialist exchange a few lines BEFORE
  // execution. Stored on todo.metadata.conversation; dashboard renders it as
  // a live chat bubble thread. Fire-and-forget: if generation fails we still
  // run the task. Skipped for retry attempts to avoid duplicate conversations.
  generateTaskConversation({
    anthropic,
    taskTitle:     todo.title,
    poolName,
    recentLessons: loadAgentMemory(poolName)?.lessons ?? [],
  }).then(async (conversation) => {
    if (!conversation || !conversation.length) return
    try {
      const { data: cur } = await supabase.from('todos').select('metadata').eq('id', todo.id).single()
      const meta = { ...(cur?.metadata ?? {}), conversation }
      await supabase.from('todos').update({ metadata: meta }).eq('id', todo.id)
      console.log(`[${agentName}] conversation: ${conversation.length} turns stored`)
    } catch {}
  }).catch(() => {})

  try {
    console.log(`[${agentName}] Starting: "${todo.title}"`)

    let result
    try {
      // First attempt
      result = await runAgentLoop(todo, agentName, model, poolName)
    } catch (firstErr) {
      const isRateLimit = firstErr.status === 429 || firstErr.message?.includes('rate_limit') || firstErr.message?.includes('429')
      if (isRateLimit) throw firstErr

      // Self-healing: retry once with error context
      const failureReason = firstErr.message?.slice(0, 200) ?? 'unknown error'
      console.log(`[${agentName}] First attempt failed — self-healing retry...`)
      await addComment(todo.id, agentName, `First approach failed: ${failureReason.slice(0, 100)}. Retrying with alternative strategy...`)
      result = await runAgentLoop(todo, agentName, model, poolName, { isRetry: true, failureReason })
    }

    const { summary, filesChanged, totalCost } = result
    const costStr = totalCost > 0 ? ` | cost: $${totalCost.toFixed(5)}` : ''
    const resultText = [
      summary,
      filesChanged.length > 0 ? `Files changed: ${filesChanged.join(', ')}` : null,
      totalCost > 0 ? `API cost: $${totalCost.toFixed(5)}` : null,
    ].filter(Boolean).join('\n')

    // Record hourly cost for this pool's circuit breaker budget gate
    if (totalCost > 0) recordPoolCost(poolName, totalCost)
    // Curriculum tracker — feed success
    recordPoolOutcome(poolName, 'completed')

    console.log(`[${agentName}] Done: ${summary}${costStr}`)
    await addComment(todo.id, agentName, resultText)
    await updateTask(todo.id, 'completed', agentName)
    await webhook(`✓ [${agentName}] completed: "${todo.title}"`)

    if (todo.is_boss) await webhook(`★ BOSS SLAIN by ${agentName}: "${todo.title}" ★`)

    updateAgentMemory(poolName, `"${todo.title.slice(0, 60)}" succeeded — ${summary.slice(0, 100)}`)

    // Background quality grade — doesn't block the loop
    scoreTaskQuality(todo.id, todo.title, resultText).catch(() => {})

  } catch (err) {
    const msg = err.message?.slice(0, 200) ?? 'unknown error'
    const isRateLimit  = err.status === 429 || msg.includes('rate_limit') || msg.includes('429')
    const isCredit     = isCreditError(err)
    const isPauseable  = isRateLimit || isCredit
    console.error(`[${agentName}] ${isCredit ? 'Credit exhausted' : isRateLimit ? 'Rate limited' : 'Failed'} (${msg.slice(0, 80)})`)

    if (isPauseable) {
      // Don't mark as failed — reset so it runs when credits/rate limits clear
      await supabase.from('todos').update({ status: 'pending', assigned_agent: null }).eq('id', todo.id)
    } else {
      // Hard failure — feed both the circuit breaker AND the curriculum tracker
      recordPoolFailure(poolName)
      recordPoolOutcome(poolName, 'failed')
      await addComment(todo.id, agentName, `Failed: ${msg}`)
      await updateTask(todo.id, 'failed', agentName)
      await webhook(`✕ [${agentName}] failed: "${todo.title}"`)
      updateAgentMemory(poolName, `FAILED: "${todo.title.slice(0, 60)}" — ${msg.slice(0, 80)}`)
    }
  } finally {
    activeAgents.delete(todo.id)
  }
}

// ── Stale task detection + escalation ─────────────────────────────────────
// Graduated response (Composio orchestrator pattern):
//   10min  stuck in_progress + no active agent → reset (try again)
//   2nd   occurrence                          → escalate: mark failed with reason
//   pending >60min                             → kill as "abandoned" (vetoed)
// Escalation state lives in metadata.stale_count so it survives process restarts.
async function resetStaleTasks() {
  try {
    const now         = Date.now()
    const tenMinAgo   = new Date(now - 10  * 60 * 1000).toISOString()
    const sixtyMinAgo = new Date(now - 60  * 60 * 1000).toISOString()

    // A) stuck in_progress with no active agent
    const { data: stuck } = await supabase
      .from('todos')
      .select('id, title, metadata, retry_count')
      .eq('status', 'in_progress')
      .lt('updated_at', tenMinAgo)

    for (const task of stuck ?? []) {
      if (activeAgents.has(task.id)) continue
      const count = Number(task.metadata?.stale_count ?? 0) + 1
      const meta  = { ...(task.metadata ?? {}), stale_count: count, last_stale_at: new Date().toISOString() }

      if (count >= 2) {
        console.log(`[ruflo] ⚠ Escalating repeat-stuck task: "${task.title.slice(0, 60)}"`)
        await supabase.from('todos').update({
          status: 'failed',
          metadata: { ...meta, failure_reason: `stuck ${count}× with no agent progress` },
          assigned_agent: null,
        }).eq('id', task.id)
      } else {
        console.log(`[ruflo] Stale reset #${count}: "${task.title.slice(0, 60)}"`)
        await supabase.from('todos').update({
          status: 'pending',
          assigned_agent: null,
          metadata: meta,
        }).eq('id', task.id)
      }
    }

    // B) pending never picked up after 60min — likely obsolete
    const { data: abandoned } = await supabase
      .from('todos')
      .select('id, title')
      .eq('status', 'pending')
      .lt('created_at', sixtyMinAgo)

    for (const task of abandoned ?? []) {
      console.log(`[ruflo] Abandoning long-pending task: "${task.title.slice(0, 60)}"`)
      await supabase.from('todos').update({
        status: 'vetoed',
        metadata: { abandoned_at: new Date().toISOString(), reason: 'pending >60min — likely obsolete' },
      }).eq('id', task.id)
    }
  } catch (e) {
    console.log(`[ruflo] stale check error: ${e.message?.slice(0, 80)}`)
  }
}

// ── Poll + realtime ───────────────────────────────────────────────────────
async function pollPending() {
  await resetStaleTasks()

  // Auto-unpause credits after 10 minutes (user may have topped up)
  if (creditsPaused && Date.now() - creditsPausedAt > 10 * 60 * 1000) {
    console.log('[ruflo] Re-checking credits after pause...')
    creditsPaused = false
  }

  if (creditsPaused) {
    console.log('[ruflo] ⛔ Credits exhausted — top up at console.anthropic.com/billing')
    return
  }

  const todaySpend = getTodaySpend()
  if (todaySpend >= DAILY_LIMIT_USD) {
    console.log(`[ruflo] 💰 Daily limit reached: $${todaySpend.toFixed(4)} / $${DAILY_LIMIT_USD} — no new tasks until tomorrow`)
    return
  }

  if (activeAgents.size >= MAX_PARALLEL) return

  const slots = MAX_PARALLEL - activeAgents.size
  const { data, error } = await supabase
    .from('todos')
    .select('*')
    .eq('status', 'pending')
    .not('assigned_agent', 'is', null)
    .order('created_at', { ascending: true })
    .limit(slots)

  if (error) { console.error('[ruflo] Poll error:', error.message); return }
  if (!data?.length) return

  for (const todo of data) {
    if (!activeAgents.has(todo.id) && activeAgents.size < MAX_PARALLEL) {
      runAgent(todo)
    }
  }
}

supabase
  .channel('ruflo-watch')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'todos' }, ({ new: todo }) => {
    if (todo.status === 'pending' && todo.assigned_agent) {
      console.log(`[ruflo] New task: "${todo.title}"`)
      if (activeAgents.size < MAX_PARALLEL) runAgent(todo)
    }
  })
  .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'todos' }, ({ new: todo }) => {
    if (todo.status === 'pending' && todo.assigned_agent && !activeAgents.has(todo.id) && activeAgents.size < MAX_PARALLEL) {
      runAgent(todo)
    }
  })
  .subscribe()

// ── Boot ──────────────────────────────────────────────────────────────────
console.log('🌊 Ruflo agent runner v2 — 12 improvements active')
console.log(`   Parallel slots: ${MAX_PARALLEL}`)
console.log(`   Smart routing: Haiku → Sonnet on keyword match`)
console.log(`   New tools: patch_file, create_subtask`)
console.log(`   Features: preflight, self-healing retry, stale detection, context compression`)
console.log(`   Wall-clock timeout: 8 minutes per task\n`)

pollPending()
setInterval(pollPending, 15_000)
