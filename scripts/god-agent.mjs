/**
 * god-agent.mjs — The GOD agent v2
 *
 * An evolving, self-improving orchestrator with:
 *  - Goal-directed strategic roadmap
 *  - Agent performance tracking + smart routing
 *  - Multi-agent council decisions
 *  - Task completion reviewer
 *  - Self-improvement loop
 *  - Dynamic priority scoring
 *  - Regression detection + rollback
 *  - Direct dashboard editing (every 5 cycles)
 *
 * pm2 start scripts/god-agent.mjs --name god
 */

import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { execSync, execFileSync } from 'node:child_process'
import { assertOpsAgentsEnabled, checkWritePath, checkReadPath, checkOperation, violations } from './lib-agent-permissions.mjs'
import { notify, shouldNotify } from './lib-notify.mjs'
import { pruneWisdom } from './god/memory.mjs'
import { publishSharedBatch } from './lib-shared-memory.mjs'
import { runMarketResearch } from './god/market-research.mjs'
import { runFunnelAnalysis } from './god/funnel-analyzer.mjs'
import { runListingOptimizer } from './god/listing-optimizer.mjs'
import { askLLM, isInFallback } from './lib-llm.mjs'
import { detectEmergentGoals } from './god/goal-emergence.mjs'
import { updateUserModel, readUserModelSummary } from './god/user-modeler.mjs'
import { verifyGitCommit, verifyAndLog } from './lib-verify.mjs'

const __dirname   = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')

// ── Load env first ────────────────────────────────────────────────────────
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

// Kill switch: ops agents are off unless OPS_AGENTS_ENABLED=true.
assertOpsAgentsEnabled('god-agent')

const supabase = createClient(
  process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const WISDOM_PATH       = join(__dirname, 'god-wisdom.json')
const RESEARCH_LOG_PATH = join(__dirname, 'god-research.json')
const COST_LOG_PATH     = join(__dirname, 'cost-log.json')

// ── Spend guard ────────────────────────────────────────────────────────────
// Fallback defaults match .env.local — safe values if env not loaded
const DAILY_LIMIT_USD = parseFloat(process.env.DAILY_COST_LIMIT_USD ?? '5.00')

function getGodTodaySpend() {
  try {
    const log = JSON.parse(readFileSync(COST_LOG_PATH, 'utf8'))
    const today = new Date().toISOString().slice(0, 10)
    return (log.sessions ?? [])
      .filter(s => s.at?.startsWith(today))
      .reduce((sum, s) => sum + (s.cost ?? 0), 0)
  } catch { return 0 }
}

// Rate-of-spend over a rolling window. If God is burning money fast
// (runaway loop, expensive tool use), pause before the daily cap is hit.
function getRecentSpend(windowMin) {
  try {
    const log = JSON.parse(readFileSync(COST_LOG_PATH, 'utf8'))
    const cutoff = Date.now() - windowMin * 60_000
    return (log.sessions ?? [])
      .filter(s => s.at && new Date(s.at).getTime() >= cutoff)
      .reduce((sum, s) => sum + (s.cost ?? 0), 0)
  } catch { return 0 }
}

function isCreditError(err) {
  return err.status === 400 && (
    err.message?.includes('credit balance') ||
    err.message?.includes('Your credit balance is too low')
  )
}

// ── Build/lint verification for God edits ───────────────────────────────────
// Counts TypeScript errors; caller compares pre- vs post-edit to decide if
// the edit introduced new breakage. This is more robust than "any errors = bad"
// because the repo already has known pre-existing TS errors.
function countTsErrors() {
  try {
    execSync('npx tsc --noEmit', { cwd: PROJECT_ROOT, stdio: 'pipe', timeout: 60_000 })
    return { count: 0, sample: '' }
  } catch (e) {
    const stdout = e.stdout?.toString() ?? ''
    const stderr = e.stderr?.toString() ?? ''
    const combined = stdout + stderr
    const count = (combined.match(/error TS/g) ?? []).length
    return { count, sample: combined.split('\n').find(l => l.includes('error TS'))?.slice(0, 160) ?? '' }
  }
}

function verifyCommit(baseline) {
  const { count, sample } = countTsErrors()
  if (count <= baseline) return { ok: true }
  return {
    ok: false,
    reason: `TypeScript: ${count - baseline} new error${count - baseline > 1 ? 's' : ''} (was ${baseline}, now ${count}) — ${sample}`,
  }
}

// ── Review-before-ship (inspired by gstack /review) ────────────────────────
// TypeScript check catches *compile* errors. This catches *logic* bugs,
// security issues, missing error handling — the stuff that passes tsc
// but blows up at runtime. Runs Haiku over the diff after verify passes,
// only blocks commit if severity is 'critical'.
async function reviewDiff(sha) {
  try {
    // Cap diff size — very large diffs aren't worth reviewing and blow tokens
    const diff = gitExec(`git show --format="" --no-color --stat ${sha}`)?.slice(0, 500) ?? ''
    const contents = gitExec(`git show --format="" --no-color ${sha}`)?.slice(0, 8000) ?? ''
    if (contents.length < 100) return { ok: true, findings: [] }  // trivial diff — skip

    const response = await anthropic.messages.create({
      model: MODELS.haiku,
      max_tokens: 500,
      messages: [{ role: 'user', content: `You are a Staff Engineer doing a code review on an autonomous agent's commit.

Look for:
- Logic bugs that would compile but fail at runtime (null access, wrong conditions, off-by-one)
- Missing error handling on fetch/exec/db calls
- Security issues (SQL injection, path traversal, unsanitized user input, exposed secrets)
- Dead / unreachable code

IGNORE: style, naming, formatting, minor TS complaints. Only flag what would cause a real bug in production.

Commit stat:
${diff}

Commit contents:
${contents}

Reply ONLY with JSON:
{
  "severity": "ok" | "minor" | "major" | "critical",
  "findings": ["one line per finding, specific and actionable"]
}

Use "critical" ONLY for things that would data-loss, auth-bypass, or take the system down. "major" for definite bugs. "minor" for suspect code. "ok" for clean commits.` }],
    })
    const text = response.content[0]?.type === 'text' ? response.content[0].text : ''
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return { ok: true, findings: [] }
    const r = JSON.parse(match[0])
    return {
      ok:       r.severity !== 'critical',
      severity: r.severity,
      findings: r.findings ?? [],
    }
  } catch (e) {
    console.log(`[GOD-REVIEW] skipped (${e.message?.slice(0, 80)})`)
    return { ok: true, findings: [] }  // fail-open: don't block on reviewer errors
  }
}

// ── Git auto-commit ────────────────────────────────────────────────────────
function gitExec(cmd) {
  try {
    return execSync(cmd, { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
  } catch (e) {
    return null
  }
}

function hasGitRepo() { return gitExec('git rev-parse --is-inside-work-tree') === 'true' }

// ── Runtime rollback support (model-watchdog pattern) ─────────────────────
// After every auto-commit we write a pending record to pending-commits.json.
// The watchdog process checks each record: once 20 tasks have closed since
// the commit, if success rate dropped >15pp vs the 20 tasks before, revert.
const PENDING_COMMITS_PATH = join(PROJECT_ROOT, 'scripts', 'pending-commits.json')

function loadPendingCommits() {
  try { return JSON.parse(readFileSync(PENDING_COMMITS_PATH, 'utf8')) } catch { return { pending: [] } }
}

function recordPendingCommit(entry) {
  try {
    const log = loadPendingCommits()
    log.pending = [...(log.pending ?? []).slice(-19), entry]
    writeFileSync(PENDING_COMMITS_PATH, JSON.stringify(log, null, 2), 'utf8')
  } catch {}
}

async function autoCommit({ cycle, source, summary, files }) {
  if (!hasGitRepo()) return null

  // Capture TypeScript error baseline BEFORE the edit lands in the index
  const baseline = process.env.GOD_VERIFY !== 'false' ? countTsErrors().count : 0

  const branchBefore = gitExec('git rev-parse --abbrev-ref HEAD') ?? 'main'
  const useBranch = process.env.GOD_PR_MODE === 'true'
  const targetBranch = useBranch ? `god/cycle-${cycle}-${source}` : branchBefore

  if (useBranch) {
    gitExec(`git checkout -b ${targetBranch}`)
  }

  // Permission boundary: refuse the whole commit if any file is protected.
  const blocked = violations(files, PROJECT_ROOT)
  if (blocked.length) {
    console.log(`[GOD-GIT] refused — protected paths: ${blocked.map(b => b.path ?? b.reason).join(', ')}`)
    if (useBranch) gitExec(`git checkout ${branchBefore}`)
    return null
  }
  try { execFileSync('git', ['add', '--', ...files], { cwd: PROJECT_ROOT, stdio: 'pipe' }) } catch { return null }

  const hasChanges = gitExec('git diff --cached --quiet; echo $?') !== '0'
  if (!hasChanges) {
    if (useBranch) gitExec(`git checkout ${branchBefore}`)
    return null
  }

  const subjectPrefix = source === 'dashboard' ? '[god-edit]' : '[god-agent]'
  const safeSummary = summary.replace(/"/g, "'").slice(0, 72)
  try {
    execFileSync('git', ['commit', '-m', `${subjectPrefix} cycle ${cycle}: ${safeSummary}`], { cwd: PROJECT_ROOT, stdio: 'pipe' })
  } catch { return null }
  const sha = gitExec('git rev-parse --short HEAD')

  // Record pending verification — watchdog checks success rate 20 tasks later
  recordPendingCommit({ sha, cycle, source, summary: safeSummary, at: new Date().toISOString() })

  // Verify the commit actually exists in git log (catches silent cwd/index issues)
  verifyAndLog(PROJECT_ROOT, 'git-commit',
    () => Promise.resolve(verifyGitCommit(sha, PROJECT_ROOT)),
    { sha, cycle, source, summary: safeSummary.slice(0, 60) },
  ).catch(() => {})

  // ── Verification — revert if the edit broke the build ────────────────────
  if (process.env.GOD_VERIFY !== 'false') {
    const verifyResult = verifyCommit(baseline)
    if (verifyResult && !verifyResult.ok) {
      console.log(`[GOD-VERIFY] ${verifyResult.reason} — reverting ${sha}`)
      gitExec(`git revert --no-edit ${sha}`)
      const revertSha = gitExec('git rev-parse --short HEAD')
      await notify('error', `God edit auto-reverted`, `Cycle ${cycle} (${source}): ${verifyResult.reason}\nReverted ${sha} → ${revertSha}`)
      return { sha: revertSha, branch: targetBranch, reverted: true, reason: verifyResult.reason }
    }
  }

  // ── Logic / security review (Staff Engineer pass) ────────────────────────
  // Only runs when GOD_REVIEW is explicitly enabled — adds ~\$0.005/edit.
  // Uses Haiku to catch bugs tsc missed (logic errors, unhandled promises,
  // injection risks). Critical findings → revert. Minor/major → logged.
  if (process.env.GOD_REVIEW === 'true') {
    const review = await reviewDiff(sha)
    const findings = review.findings ?? []
    if (findings.length > 0) {
      console.log(`[GOD-REVIEW] ${review.severity}: ${findings.slice(0, 2).join(' | ')}`)
    }
    if (!review.ok) {
      console.log(`[GOD-VERIFY] Reviewer flagged CRITICAL — reverting ${sha}`)
      gitExec(`git revert --no-edit ${sha}`)
      const revertSha = gitExec('git rev-parse --short HEAD')
      await notify('error', 'God edit auto-reverted (code review)',
        `Cycle ${cycle} (${source}): Staff Engineer reviewer flagged critical issues:\n${findings.join('\n')}\nReverted ${sha} → ${revertSha}`)
      return { sha: revertSha, branch: targetBranch, reverted: true, reason: 'reviewer: ' + findings[0] }
    }
  }

  // Pushing, remote rewriting and PR creation are disabled for agents
  // (lib-agent-permissions: git.push). The previous implementation embedded
  // GITHUB_TOKEN in the remote URL, persisting it in .git/config. A human
  // reviews and pushes agent commits.
  const prUrl = null
  if (process.env.GITHUB_TOKEN) console.log(`[GOD-GIT] ${checkOperation('git.push').reason} — commit left local for human review`)

  if (useBranch) gitExec(`git checkout ${branchBefore}`)

  console.log(`[GOD-GIT] ${sha} on ${targetBranch} — ${files.length} files`)
  return { sha, branch: targetBranch, prUrl }
}

function buildPrBody({ cycle, source, files, summary, sha }) {
  return [
    `## Autonomous change by GOD agent`,
    ``,
    `- **Cycle:** ${cycle}`,
    `- **Source:** ${source === 'dashboard' ? 'Dashboard self-improvement' : 'Agent script self-improvement'}`,
    `- **Commit:** \`${sha}\``,
    ``,
    `### Summary`,
    summary,
    ``,
    `### Files changed (${files.length})`,
    files.map(f => `- \`${f}\``).join('\n'),
    ``,
    `---`,
    `🤖 Opened by GOD agent. Review the diff before merging.`,
  ].join('\n')
}

async function openPullRequest({ repo, token, head, base, title, body }) {
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/pulls`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept':        'application/vnd.github+json',
        'User-Agent':    'god-agent',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ title, body, head, base }),
    })
    if (!r.ok) {
      console.log(`[GOD-PR] API failed ${r.status}: ${(await r.text()).slice(0, 120)}`)
      return null
    }
    const j = await r.json()
    return j.html_url ?? null
  } catch (e) {
    console.log(`[GOD-PR] Error: ${e.message}`)
    return null
  }
}

// ── Web helpers ────────────────────────────────────────────────────────────
async function webSearch(query) {
  try {
    const q = encodeURIComponent(query)
    const res = await fetch(
      `https://api.duckduckgo.com/?q=${q}&format=json&no_redirect=1&no_html=1&skip_disambig=1`,
      { signal: AbortSignal.timeout(10000) }
    )
    const data = await res.json()
    const parts = [
      data.AbstractText && `Summary: ${data.AbstractText}`,
      ...(data.RelatedTopics ?? []).slice(0, 6).map(t => t.Text).filter(Boolean),
    ].filter(Boolean)
    return parts.length ? parts.join('\n\n') : null
  } catch (e) {
    console.log(`[GOD-WEB] Search failed: ${e.message}`)
    return null
  }
}

async function fetchUrl(url) {
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers: { 'Accept': 'text/plain', 'X-No-Cache': 'true' },
      signal: AbortSignal.timeout(15000),
    })
    return (await res.text()).slice(0, 5000)
  } catch (e) {
    console.log(`[GOD-WEB] Fetch failed: ${e.message}`)
    return null
  }
}

function loadResearchLog() {
  try { if (existsSync(RESEARCH_LOG_PATH)) return JSON.parse(readFileSync(RESEARCH_LOG_PATH, 'utf8')) } catch {}
  return { entries: [], queriesAsked: [] }
}

function saveResearchLog(log) {
  try { writeFileSync(RESEARCH_LOG_PATH, JSON.stringify(log, null, 2), 'utf8') } catch {}
}

// ── Claude helpers ────────────────────────────────────────────────────────
async function ask(prompt, { model = 'sonnet', maxTokens = 800, cacheablePrefix = null } = {}) {
  let delay = 60_000

  // If we're already in Ollama-fallback mode (previous credit error set it),
  // route through askLLM which handles provider selection + error handling.
  if (isInFallback()) {
    try {
      const { text, provider } = await askLLM({ anthropic, prompt, model, maxTokens, models: MODELS })
      if (provider === 'ollama') console.log(`[GOD] ⇄ ollama fallback answered`)
      return text
    } catch {}
    // fall through to the Anthropic path below
  }

  // If the caller passes a `cacheablePrefix` (stable context repeated across
  // cycles — schema info, lessons, roadmap), mark it as an ephemeral cache
  // block. Anthropic charges 10% of input rate on cache reads after first.
  const content = cacheablePrefix
    ? [
        { type: 'text', text: cacheablePrefix, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: prompt },
      ]
    : [{ type: 'text', text: prompt }]

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const msg = await anthropic.messages.create({
        model: MODELS[model] ?? MODELS.sonnet,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content }],
      })
      return msg.content[0]?.type === 'text' ? msg.content[0].text : ''
    } catch (err) {
      if (isCreditError(err)) {
        console.error('[GOD] ⛔ credit exhausted — routing to Ollama fallback')
        // Route this call through askLLM so Ollama picks it up; also flips
        // the inFallback flag so subsequent calls skip Anthropic for 30 min.
        try {
          const { text, provider } = await askLLM({ anthropic, prompt, model, maxTokens, models: MODELS })
          if (provider === 'ollama') return text
        } catch {}
        throw err  // Ollama unreachable too — propagate so caller can pause
      }
      const is429 = err.status === 429 || err.message?.includes('rate_limit')
      if (is429 && attempt < 3) {
        console.log(`[GOD] Rate limited — waiting ${delay/1000}s...`)
        await new Promise(r => setTimeout(r, delay))
        delay = Math.min(delay * 1.5, 300_000)
        continue
      }
      throw err
    }
  }
  return ''
}

function extractJSON(text, fallback = null) {
  if (!text || typeof text !== 'string') return fallback
  const stripped = text.replace(/```(?:json)?\s*|\s*```/g, '').trim()

  // Try parsing the whole string first (best case — Claude returned pure JSON)
  try { return JSON.parse(stripped) } catch {}

  // Greedy array match, then greedy object match, then non-greedy fallbacks
  const candidates = [
    stripped.match(/\[[\s\S]*\]/),
    stripped.match(/\{[\s\S]*\}/),
    stripped.match(/\[[\s\S]*?\]/),
    stripped.match(/\{[\s\S]*?\}/),
  ]
  for (const m of candidates) {
    if (!m) continue
    try { return JSON.parse(m[0]) } catch {}
  }
  return fallback
}

/**
 * Structured output helper — uses tool_use to guarantee valid JSON matching
 * a schema. Preferred over extractJSON() for new code.
 *
 * Usage:
 *   const result = await askJSON('Give me 3 tasks', {
 *     schema: {
 *       type: 'object',
 *       properties: {
 *         tasks: { type: 'array', items: { type: 'object', properties: {
 *           title: { type: 'string' }, priority: { type: 'string' },
 *         }, required: ['title', 'priority'] } }
 *       },
 *       required: ['tasks'],
 *     },
 *   })
 */
async function askJSON(prompt, { model = 'haiku', maxTokens = 600, schema, toolName = 'emit_result', cacheablePrefix = null } = {}) {
  const tools = [{
    name:         toolName,
    description:  'Return the structured result for this task.',
    input_schema: schema ?? { type: 'object', properties: { value: {} } },
  }]

  const content = cacheablePrefix
    ? [
        { type: 'text', text: cacheablePrefix, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: prompt },
      ]
    : [{ type: 'text', text: prompt }]

  try {
    const msg = await anthropic.messages.create({
      model:        MODELS[model] ?? MODELS.haiku,
      max_tokens:   maxTokens,
      tools,
      tool_choice:  { type: 'tool', name: toolName },
      messages:     [{ role: 'user', content }],
    })
    const block = msg.content.find(b => b.type === 'tool_use')
    return block?.input ?? null
  } catch (err) {
    if (isCreditError(err)) throw err
    console.log(`[GOD-ASK-JSON] failed: ${err.message?.slice(0, 100)}`)
    return null
  }
}

// ── God status ────────────────────────────────────────────────────────────
async function setGodThought(thought, meta = null) {
  console.log(`[GOD] ${thought}`)
  try {
    const payload = { id: 1, thought, updated_at: new Date().toISOString() }
    if (meta) payload.meta = meta
    await supabase.from('god_status').upsert(payload)
  } catch {}
}

function deriveMood(wisdom) {
  const { attempted, succeeded, failed } = wisdom.taskStats
  if (attempted < 3) return { mood: 'AWAKENING', color: 'cyan', icon: '◈' }
  const rate = succeeded / Math.max(attempted, 1)
  if (rate >= 0.80) return { mood: 'OMNIPOTENT', color: 'yellow', icon: '★' }
  if (rate >= 0.55) return { mood: 'VIGILANT',   color: 'green',  icon: '◉' }
  if (rate >= 0.35) return { mood: 'TROUBLED',   color: 'orange', icon: '◎' }
  return { mood: 'SUFFERING', color: 'red', icon: '✕' }
}

// ── Persistent wisdom ─────────────────────────────────────────────────────
const WISDOM_DEFAULTS = {
  cycles: 0,
  lessons: [],
  avoidPatterns: [],
  successPatterns: [],
  agentStats: {},
  roadmap: { goals: [], completedGoals: [] },
  recentReviews: [],
  taskStats: { attempted: 0, succeeded: 0, failed: 0 },
  lastReflection: null,
  lastRoadmapUpdate: null,
  dashboardEdits: [],      // log of god's own dashboard edits
  failurePostmortems: [],  // root causes extracted from failed task comments
  lastDecrees: [],         // titles created last cycle for sequential tracking
  categoryStats: {         // per-category success tracking
    db:       { succeeded: 0, failed: 0 },
    ui:       { succeeded: 0, failed: 0 },
    infra:    { succeeded: 0, failed: 0 },
    analysis: { succeeded: 0, failed: 0 },
    other:    { succeeded: 0, failed: 0 },
  },
  decisionHistory: [],     // last 20 cycle decisions for dashboard display

  // ── Proactive self-improvement state ──────────────────────────────────────
  goals: [],               // [{ id, text, targetCycle, createdCycle, progress: 0-1, rationale, status: 'active'|'completed'|'abandoned' }]
  completedGoals: [],      // finished goals, capped at 20
  selfReflections: [],     // meta-cognitive reflections, every 25 cycles
  researchLog: [],         // patterns read from external repos + integration ideas
  curiosityLog: [],        // exploratory topics God has explored
}

// ── 4. Proven safe-mode task templates ────────────────────────────────────
const TASK_TEMPLATES = [
  { title: 'Query all todos grouped by status and log the counts using agent_exec_sql', priority: 'low' },
  { title: 'Run SELECT COUNT(*) on each public table and log results via agent_exec_sql', priority: 'low' },
  { title: 'Query god_status table and log the current thought and cycle count', priority: 'low' },
  { title: 'List all indexes on the todos table via information_schema query', priority: 'low' },
  { title: 'Read components/StatsBar.tsx and add a brief comment explaining its purpose', priority: 'low' },
  { title: 'Query traces table and log the 5 most recent tool calls with their durations', priority: 'low' },
  { title: 'Run EXPLAIN on SELECT * FROM todos WHERE status=pending to check query plan', priority: 'low' },
]

function getSafeModeTasks(todos, wisdom) {
  const existingTitles = new Set(todos.map(t => t.title.toLowerCase()))
  return TASK_TEMPLATES
    .filter(t => !existingTitles.has(t.title.toLowerCase()))
    .filter(t => !(wisdom.avoidPatterns ?? []).some(p => t.title.toLowerCase().includes(p.toLowerCase())))
    .slice(0, 1) // one safe task at a time
}

// ── Task category classifier ──────────────────────────────────────────────
const CAT_KEYWORDS_GOD = {
  db:       ['sql','query','table','database','schema','postgres','supabase','migration','index','agent_exec_sql','ddl','select','trigger','rpc','function'],
  ui:       ['component','tsx','react','tailwind','dashboard','ui','button','form','chart','graph','page','layout','style','animation','modal','panel'],
  infra:    ['pm2','deploy','ci','docker','server','npm','package','config','env','script','runner','cron','webhook'],
  analysis: ['analyze','analyse','review','report','audit','check','assess','evaluate','summarize','count','stats','metrics','log'],
}

function classifyTask(title) {
  const lower = title.toLowerCase()
  for (const [cat, kws] of Object.entries(CAT_KEYWORDS_GOD)) {
    if (kws.some(kw => lower.includes(kw))) return cat
  }
  return 'other'
}

function buildCategoryStats(todos) {
  const stats = {
    db:       { succeeded: 0, failed: 0 },
    ui:       { succeeded: 0, failed: 0 },
    infra:    { succeeded: 0, failed: 0 },
    analysis: { succeeded: 0, failed: 0 },
    other:    { succeeded: 0, failed: 0 },
  }
  for (const t of todos) {
    const cat = classifyTask(t.title)
    if (t.status === 'completed') stats[cat].succeeded++
    if (t.status === 'failed')    stats[cat].failed++
  }
  return stats
}

function categorySuccessRate(cat, categoryStats) {
  const s = categoryStats?.[cat]
  if (!s) return 50
  const total = s.succeeded + s.failed
  return total === 0 ? 50 : Math.round(s.succeeded / total * 100)
}

function loadWisdom() {
  try {
    if (existsSync(WISDOM_PATH)) {
      const saved = JSON.parse(readFileSync(WISDOM_PATH, 'utf8'))
      // Merge with defaults so new fields are always present
      return {
        ...WISDOM_DEFAULTS, ...saved,
        agentStats:      saved.agentStats      ?? {},
        roadmap:         saved.roadmap         ?? WISDOM_DEFAULTS.roadmap,
        taskStats:       saved.taskStats       ?? WISDOM_DEFAULTS.taskStats,
        categoryStats:   saved.categoryStats   ?? WISDOM_DEFAULTS.categoryStats,
        decisionHistory: saved.decisionHistory ?? [],
      }
    }
  } catch {}
  return { ...WISDOM_DEFAULTS }
}

const AGENT_MEMORY_DIR = join(PROJECT_ROOT, 'scripts', 'agent-memory')

function saveWisdom(w) {
  try { writeFileSync(WISDOM_PATH, JSON.stringify(w, null, 2), 'utf8') } catch {}

  // Bridge God's high-signal learnings into the shared cross-agent pool so
  // specialists see them too. Only last few of each type — don't drown the
  // shared lesson stream.
  const bridged = [
    ...(w.lessons         ?? []).filter(l => l.startsWith('[WEB-FIX]') || l.startsWith('[META]')).slice(-5),
    ...(w.successPatterns ?? []).slice(-5),
    ...(w.avoidPatterns   ?? []).filter(p => p.startsWith('!')).slice(-5).map(p => `AVOID: ${p.slice(2)}`),
  ]
  if (bridged.length) publishSharedBatch(AGENT_MEMORY_DIR, bridged)
}

// Memory dedup (lessonTokens, jaccard, dedupLessons, pruneWisdom) extracted
// to ./god/memory.mjs — pure functions, unit-tested separately.

// ── Survey ────────────────────────────────────────────────────────────────
async function survey() {
  const { data } = await supabase
    .from('todos').select('*')
    .order('created_at', { ascending: false }).limit(60)
  return data ?? []
}

async function surveySchema() {
  try {
    const { data: tables }    = await supabase.rpc('agent_exec_sql', { query: `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name` })
    const { data: functions } = await supabase.rpc('agent_exec_sql', { query: `SELECT routine_name FROM information_schema.routines WHERE routine_schema='public' ORDER BY routine_name` })
    return {
      tableNames: (tables ?? []).map(r => r.table_name).join(', ') || 'todos, god_status',
      funcNames:  (functions ?? []).map(r => r.routine_name).join(', ') || 'agent_exec_sql, agent_exec_ddl',
    }
  } catch {
    return { tableNames: 'todos, god_status', funcNames: 'agent_exec_sql, agent_exec_ddl' }
  }
}

// ── 1. Agent performance tracking ────────────────────────────────────────
function updateAgentStats(todos, wisdom) {
  const stats = { ...wisdom.agentStats }

  for (const t of todos) {
    if (!t.assigned_agent) continue
    // Normalise agent name to its pool (strip the unique suffix)
    const pool = t.assigned_agent.replace(/-[a-f0-9]{6}$/, '')
    if (!stats[pool]) stats[pool] = { completed: 0, failed: 0, taskTypes: [] }

    if (t.status === 'completed') stats[pool].completed++
    if (t.status === 'failed')    stats[pool].failed++

    // Infer task type keyword
    const kw = t.title.split(' ').slice(0, 3).join(' ').toLowerCase()
    if (!stats[pool].taskTypes.includes(kw)) {
      stats[pool].taskTypes = [...stats[pool].taskTypes.slice(-10), kw]
    }
  }

  return { ...wisdom, agentStats: stats }
}

// Pick best agent pool based on performance history
const SPECIALIST_MAP = {
  db:       'db-specialist',
  ui:       'ui-specialist',
  infra:    'ruflo-critical',
  analysis: 'ruflo-high',
  other:    'ruflo-medium',
}

function pickAgent(taskTitle, agentStats, categoryStats) {
  const cat = classifyTask(taskTitle)

  // Use specialist agent for db/ui tasks — they get domain-tuned prompts + sonnet
  const specialist = SPECIALIST_MAP[cat]
  if (specialist) return specialist

  // Fall back to best-performing pool from history
  const pools = Object.entries(agentStats ?? {})
  if (!pools.length) return null
  const scored = pools.map(([name, s]) => ({
    name,
    score: s.completed / Math.max(s.completed + s.failed, 1),
  })).sort((a, b) => b.score - a.score)

  return scored[0]?.name ?? null
}

// ── 2. Strategic roadmap ──────────────────────────────────────────────────
async function updateRoadmap(todos, schema, wisdom) {
  const now = Date.now()
  const lastUpdate = wisdom.lastRoadmapUpdate ? new Date(wisdom.lastRoadmapUpdate).getTime() : 0
  // Only update roadmap every 4 cycles
  if (wisdom.cycles % 4 !== 0) return wisdom

  await setGodThought('Updating strategic roadmap...')

  // ── Force-retire goals older than 15 cycles BEFORE asking Haiku ──
  // Haiku tends to re-propose goals it sees in the existing list.
  // Stripping stale ones from its input forces a fresh roadmap.
  let autoRetired = 0
  for (const g of wisdom.roadmap.goals ?? []) {
    if (g.status === 'active' && g.activatedCycle !== undefined &&
        wisdom.cycles - g.activatedCycle >= 15) {
      g.status = 'completed'
      g.retiredCycle = wisdom.cycles
      g.retiredReason = 'auto-retired after 15 cycles active'
      autoRetired++
    }
  }
  if (autoRetired) console.log(`[GOD-ROADMAP] auto-retired ${autoRetired} stale goals`)

  const completedTitles = todos.filter(t => t.status === 'completed').map(t => t.title)
  // Only show ACTIVE goals to Haiku — listing completed ones invites it to
  // echo them back and we end up frozen with 0 active goals (was the case
  // for ~242 cycles before this fix).
  const activeOnly = (wisdom.roadmap.goals ?? []).filter(g => g.status === 'active')
  const existingGoals = activeOnly.map(g => {
    const age = g.activatedCycle !== undefined ? wisdom.cycles - g.activatedCycle : '?'
    return `[${g.status}, ${age} cycles active] ${g.title}`
  }).join('\n') || 'none — propose a fresh roadmap'
  const noActive = activeOnly.length === 0

  const prompt = `You are GOD planning the strategic direction of a Next.js 14 + Supabase agent dashboard.

EXISTING DB TABLES: ${schema.tableNames}
COMPLETED WORK (last 15): ${completedTitles.slice(0, 15).join(', ') || 'none'}
CURRENT ACTIVE GOALS:
${existingGoals}

CURRENT CYCLE: ${wisdom.cycles}

RULES:
${noActive
  ? '- THERE ARE NO ACTIVE GOALS. Propose 2-4 NEW strategic goals for the next 10-20 cycles. Do NOT reference past goals.'
  : '- If an active goal has been running ≥10 cycles, strongly consider marking it "completed" or "abandoned" and proposing a fresh one — stale goals produce stale task proposals.\n- Preserve at most ONE goal older than 10 cycles.\n- Always include at least one goal the council hasn\'t seen before.\n- Define 2-4 high-level strategic goals for the next 10-20 cycles.'}
- Each goal should be achievable through 3-6 sequential tasks.
- Goals must only reference tables/features that exist or can be built incrementally.
- Every goal you return MUST have status:"active" — completed goals are tracked separately.

Reply ONLY with JSON array:
[{"id":"g1","title":"goal title","priority":"high","status":"active","tasksCreated":0}]`

  try {
    const raw = await ask(prompt, { model: 'haiku', maxTokens: 400 })
    const goals = extractJSON(raw, wisdom.roadmap.goals)

    if (Array.isArray(goals)) {
      // Preserve activatedCycle on goals whose title survived the rewrite
      const oldByTitle = new Map(
        (wisdom.roadmap.goals ?? []).map(g => [g.title?.toLowerCase(), g])
      )
      const merged = goals.slice(0, 5).map(g => {
        const prior = oldByTitle.get(g.title?.toLowerCase())
        if (prior && g.status === 'active') {
          return { ...g, activatedCycle: prior.activatedCycle ?? wisdom.cycles }
        }
        if (g.status === 'active' && g.activatedCycle === undefined) {
          return { ...g, activatedCycle: wisdom.cycles }
        }
        return g
      })

      // ── Emergent goal detection — pattern-based, not prompted ──
      // Surfaces goals that arose from clustered recent failures. These
      // are tagged emergent:true so the dashboard can show them distinctly.
      let emergentAdds = []
      try {
        const emergent = await detectEmergentGoals({ supabase, wisdom })
        for (const e of emergent) {
          // Skip if the Haiku-proposed list already covers this theme
          if (merged.some(m => e.keywords.some(k => m.title?.toLowerCase().includes(k)))) continue
          emergentAdds.push({
            id:             `emergent-${wisdom.cycles}-${e.keywords[0]}`,
            title:          e.title,
            priority:       'high',
            status:         'active',
            tasksCreated:   0,
            rationale:      e.rationale,
            emergent:       true,
            activatedCycle: wisdom.cycles,
            keywords:       e.keywords,
            sampleFailures: e.sampleFailures,
          })
        }
      } catch (e) {
        console.log(`[GOD-EMERGENT] detection failed: ${e.message?.slice(0, 80)}`)
      }

      // Move any "completed" entries Haiku still echoed into completedGoals
      // archive — keep `goals` exclusively for things actively in flight.
      const stillActive = [...merged, ...emergentAdds].filter(g => g.status === 'active')
      const justFinished = [...merged, ...emergentAdds].filter(g => g.status !== 'active')
      const archive = [
        ...(wisdom.roadmap.completedGoals ?? []),
        ...justFinished.map(g => ({ ...g, retiredCycle: wisdom.cycles })),
      ].slice(-50)

      if (stillActive.length === 0) {
        console.log(`[GOD-ROADMAP] cycle ${wisdom.cycles}: Haiku returned 0 active goals — keeping previous roadmap to avoid stall`)
      }

      return {
        ...wisdom,
        roadmap: {
          goals:          stillActive.length > 0 ? stillActive.slice(0, 6) : wisdom.roadmap.goals,
          completedGoals: archive,
        },
        lastRoadmapUpdate: new Date().toISOString(),
      }
    }
  } catch (e) {
    console.log(`[GOD-ROADMAP] cycle ${wisdom.cycles}: update failed — ${e.message?.slice(0, 120)}`)
  }
  return wisdom
}

// ── 3. Task completion reviewer ────────────────────────────────────────────
async function reviewCompletions(todos, wisdom) {
  // Only review every 3 cycles
  if (wisdom.cycles % 3 !== 0) return wisdom

  const recentlyDone = todos
    .filter(t => t.status === 'completed')
    .filter(t => {
      const age = Date.now() - new Date(t.updated_at).getTime()
      return age < 30 * 60 * 1000 // completed in last 30 min
    })
    .slice(0, 5)

  if (!recentlyDone.length) return wisdom

  await setGodThought(`Reviewing ${recentlyDone.length} recent completions...`)

  const reviews = []
  for (const task of recentlyDone) {
    const lastComment = task.comments?.slice(-1)[0]?.text ?? 'no comment'

    // Hard skip: if the agent demonstrably did work, don't second-guess it.
    // A completed task with real file changes OR non-trivial cost is NOT
    // "gave up" — it shipped something the quality judge can rate separately.
    const didRealWork =
      /Files changed:/i.test(lastComment) ||
      /API cost:\s*\$0\.0[2-9]/.test(lastComment) ||    // ≥ $0.02
      /API cost:\s*\$[1-9]/.test(lastComment)            // ≥ $1
    if (didRealWork) {
      reviews.push({ taskTitle: task.title.slice(0, 80), passed: true, note: 'auto-pass (files changed or real cost)' })
      continue
    }

    const prompt = `A coding agent claimed to complete this task:
TASK: "${task.title}"
AGENT COMMENT: "${lastComment}"

Based only on the task title and what the agent said, does the comment suggest the task was actually implemented or did the agent give up / hit an error?

Reply with JSON only: {"passed": true/false, "note": "one sentence reason"}`

    try {
      const raw = await ask(prompt, { model: 'haiku', maxTokens: 150 })
      const result = extractJSON(raw, { passed: true, note: '' })
      if (result && result.passed === false) {
        console.log(`[GOD] Review flagged low-quality (no status change): "${task.title}" — ${result.note}`)
        reviews.push({ taskTitle: task.title.slice(0, 80), passed: false, note: result.note })
        // Flag via metadata ONLY — don't flip the status. The Quality Judge
        // already handles quality scoring, and the agent did enough work to
        // warrant 'completed'. Dashboard can surface these flags separately.
        const meta = { ...(task.metadata ?? {}), review_flag: 'low_quality', review_note: String(result.note ?? '').slice(0, 200) }
        await supabase.from('todos').update({ metadata: meta }).eq('id', task.id)
      } else {
        reviews.push({ taskTitle: task.title.slice(0, 80), passed: true, note: result?.note ?? '' })
      }
    } catch {}
  }

  return {
    ...wisdom,
    recentReviews: [...wisdom.recentReviews, ...reviews].slice(-20),
  }
}

// ── 4. Regression detection ───────────────────────────────────────────────
async function detectRegressions(todos, wisdom) {
  // Find agents that keep failing the same type of task
  const failedTitles = todos.filter(t => t.status === 'failed').map(t => t.title.toLowerCase())

  const duplicateFailures = failedTitles.filter((t, i) =>
    failedTitles.findIndex(x => x.includes(t.split(' ').slice(0, 4).join(' '))) !== i
  )

  if (duplicateFailures.length > 2) {
    console.log(`[GOD] Regression detected: ${duplicateFailures.length} repeated failure patterns`)
    // Add to avoid patterns
    const newAvoids = duplicateFailures.slice(0, 3).map(t => t.split(' ').slice(0, 5).join(' '))
    return {
      ...wisdom,
      avoidPatterns: [...new Set([...wisdom.avoidPatterns, ...newAvoids])].slice(-20),
    }
  }

  return wisdom
}

// ── 5. Dynamic priority scoring ────────────────────────────────────────────
async function scorePendingTasks(todos, schema = null, wisdom = null) {
  const pending = todos.filter(t => t.status === 'pending')
  if (!pending.length) return

  let vetoed = 0, boosted = 0
  const activeGoalText = wisdom?.roadmap?.goals
    ?.filter(g => g.status === 'active')
    ?.map(g => g.title?.toLowerCase()).join(' ') ?? ''

  for (const task of pending) {
    const ageHours = (Date.now() - new Date(task.created_at).getTime()) / 3600000
    const title    = task.title.toLowerCase()

    // Veto pass #1 — blocklist patterns (self-referential loops, bounded query, etc.)
    if (schema) {
      const check = validateTask(task, schema)
      if (!check.valid) {
        await supabase.from('todos').update({
          status: 'vetoed',
          metadata: { ...(task.metadata ?? {}), vetoed_by: 'requeue-veto', reason: check.reason },
        }).eq('id', task.id)
        console.log(`[GOD-REQUEUE] Vetoed stale pending "${task.title.slice(0, 50)}" — ${check.reason}`)
        vetoed++
        continue
      }
    }

    // Veto pass #2 — off-goal AND old. If it's been pending >45min AND no active
    // goal keyword matches, it's almost certainly obsolete.
    if (activeGoalText && ageHours > 0.75) {
      const taskTokens = title.split(/\s+/).filter(w => w.length >= 4)
      const goalHit = taskTokens.some(w => activeGoalText.includes(w))
      if (!goalHit) {
        await supabase.from('todos').update({
          status: 'vetoed',
          metadata: { ...(task.metadata ?? {}), vetoed_by: 'requeue-veto', reason: 'off-goal after 45min aging' },
        }).eq('id', task.id)
        console.log(`[GOD-REQUEUE] Vetoed off-goal pending "${task.title.slice(0, 50)}"`)
        vetoed++
        continue
      }
    }

    // Boost pass — older/simpler/DB tasks are cheaper & likelier to succeed
    const isSimple = task.title.split(' ').length < 15
    const isDB     = /index|function|trigger|column|table/.test(title)
    let boost = 0
    if (ageHours > 2) boost++
    if (isSimple)     boost++
    if (isDB)         boost++

    const priorityMap = { low: 0, medium: 1, high: 2, critical: 3 }
    const reverseMap  = ['low', 'medium', 'high', 'critical']
    const current     = priorityMap[task.priority] ?? 1
    const boostedP    = Math.min(current + (boost >= 2 ? 1 : 0), 3)

    if (boostedP > current) {
      await supabase.from('todos')
        .update({ priority: reverseMap[boostedP] })
        .eq('id', task.id)
      console.log(`[GOD-REQUEUE] Boosted "${task.title.slice(0, 50)}" → ${reverseMap[boostedP]}`)
      boosted++
    }
  }
  if (vetoed || boosted) console.log(`[GOD-REQUEUE] re-ranked queue: ${boosted} boosted, ${vetoed} vetoed`)
}

// ── 6. Multi-agent council ────────────────────────────────────────────────
async function councilThink(todos, schema, wisdom) {
  await setGodThought('Convening council of perspectives...')

  const completed = [], failed = [], blocked = []
  for (const t of todos) {
    if (t.status === 'completed') completed.push(t)
    else if (t.status === 'failed') failed.push(t)
    else if (t.status === 'blocked') blocked.push(t)
  }
  const failedTitles = new Set(failed.map(t => t.title.toLowerCase()))
  const summary      = todos.slice(0, 20).map(t => `[${t.status}][${t.priority}] ${t.title}`).join('\n')

  // Category success rates
  const catStats = wisdom.categoryStats ?? {}
  const catRates = Object.entries(catStats)
    .map(([cat, s]) => {
      const total = s.succeeded + s.failed
      const rate  = total === 0 ? '?' : `${Math.round(s.succeeded / total * 100)}%`
      return `${cat}:${rate}(${total} tasks)`
    }).join(' | ')

  // Theory-of-mind summary — what the user currently cares about
  const userModel = readUserModelSummary(PROJECT_ROOT)
  const userBlock = userModel && (userModel.currentFocus?.length || userModel.frustrations?.length)
    ? `\nUSER CURRENTLY FOCUSED ON: ${(userModel.currentFocus ?? []).join(' | ') || '?'}\nUSER FRUSTRATED BY: ${(userModel.frustrations ?? []).join(' | ') || 'nothing noted'}`
    : ''

  const wisdomBlock = `
LESSONS (${wisdom.lessons.length}): ${wisdom.lessons.slice(-5).join(' | ') || 'none'}
AVOID: ${wisdom.avoidPatterns.slice(-5).join(' | ') || 'none'}
WORKS: ${wisdom.successPatterns.slice(-5).join(' | ') || 'none'}
GOALS: ${wisdom.roadmap.goals.filter(g => g.status === 'active').map(g => g.title).join(' | ') || 'none'}
CATEGORY SUCCESS RATES: ${catRates || 'no data yet'}
BLOCKED TASKS: ${blocked.slice(0,3).map(t=>t.title).join(' | ') || 'none'}${userBlock}`

  const context = `
DB TABLES: ${schema.tableNames}
DB FUNCTIONS: ${schema.funcNames}
QUEUE: ${summary}
FAILED (never recreate): ${failed.slice(0, 8).map(t => t.title).join(' | ') || 'none'}
${wisdomBlock}

AGENT ROUTING NOTE: db tasks → db-specialist (sonnet), ui tasks → ui-specialist (sonnet), others → ruflo pools.
Prefer task types with highest category success rates.`

  // ── ROUND 1 — initial proposals (parallel) ────────────────────────────
  const [strat, prag, skept] = await Promise.all([
    ask(`You are the STRATEGIST on GOD's council.
Propose 2 tasks that advance the strategic roadmap goals.
${context}
Reply ONLY with JSON array: [{"title":"task","priority":"high","rationale":"why"}]`, { model: 'haiku', maxTokens: 300 }),

    ask(`You are the PRAGMATIST on GOD's council.
Propose 2 tasks GUARANTEED to succeed using only what already exists.
Only reference tables in: ${schema.tableNames}
Only reference functions in: ${schema.funcNames}
${context}
Reply ONLY with JSON array: [{"title":"task","priority":"medium","rationale":"why"}]`, { model: 'haiku', maxTokens: 300 }),

    ask(`You are the SKEPTIC on GOD's council.
Your job: reject any task that won't work. Be harsh.
${context}

For each item below, verdict APPROVE or REJECT.
Reject if: function/table doesn't exist, too vague, matches a prior failure, or needs missing prerequisites.
Available tables: ${schema.tableNames}
Available functions: ${schema.funcNames}

Reply ONLY with a list, one per line: "APPROVE: task title" or "REJECT: task title (reason)"`, { model: 'haiku', maxTokens: 300 }),
  ])

  const stratTasks   = extractJSON(strat, [])
  const pragTasks    = extractJSON(prag,  [])
  let allProposed    = [
    ...(Array.isArray(stratTasks) ? stratTasks : []),
    ...(Array.isArray(pragTasks)  ? pragTasks  : []),
  ]

  // Apply skeptic vetoes (ROUND 1 filter)
  if (skept) {
    const rejectedLines = skept.split('\n')
      .filter(l => l.trim().toUpperCase().startsWith('REJECT'))
      .map(l => l.replace(/^REJECT:\s*/i, '').split('(')[0].trim().toLowerCase())
    if (rejectedLines.length) {
      const before = allProposed.length
      allProposed = allProposed.filter(t =>
        !rejectedLines.some(rej => t.title?.toLowerCase().includes(rej.slice(0, 20)))
      )
      console.log(`[GOD-COUNCIL r1] Skeptic vetoed ${before - allProposed.length} proposals`)
    }
  }

  // ── ROUND 2 — critique round (each perspective attacks the survivors) ──
  // Only runs when we have ≥2 proposals to critique AND deliberation is enabled.
  // Disable via GOD_DELIBERATE=false if you want to save ~2× council tokens.
  if (allProposed.length >= 2 && process.env.GOD_DELIBERATE !== 'false') {
    await setGodThought(`Deliberating — critique round...`)
    const survivors = allProposed.map((t, i) => `${i + 1}. [${t.priority}] ${t.title} — ${t.rationale ?? ''}`).join('\n')

    const critiqueStrategist = await ask(`You are the STRATEGIST critiquing the council's final proposals.
Point out ONE strategic weakness in each proposal (too narrow? off-goal? obvious?). Be constructive.

Proposals:
${survivors}

Reply with one critique per proposal, one line each: "N: <critique>"`, { model: 'haiku', maxTokens: 260 })

    const critiquePragmatist = await ask(`You are the PRAGMATIST critiquing the council's final proposals.
Point out ONE practical concern per proposal (too big for one agent run? risky? ambiguous requirements?).

Proposals:
${survivors}

Available tables: ${schema.tableNames}
Reply with one critique per proposal, one line each: "N: <critique>"`, { model: 'haiku', maxTokens: 260 })

    // ── ROUND 3 — revise, with critiques in hand ──
    await setGodThought(`Revising based on critiques...`)
    const reviseRaw = await ask(`You are GOD synthesising a final set of tasks after two rounds of debate.

ORIGINAL PROPOSALS:
${survivors}

STRATEGIST CRITIQUES:
${critiqueStrategist ?? '(none)'}

PRAGMATIST CRITIQUES:
${critiquePragmatist ?? '(none)'}

Drop proposals that took legitimate hits. KEEP proposals where the critique is weak. REFINE any that can be narrowed or clarified. Output at most 3 final proposals.

Reply ONLY with JSON array: [{"title":"refined task","priority":"high|medium|low","rationale":"1-line why"}]`, { model: 'haiku', maxTokens: 400 })

    const revised = extractJSON(reviseRaw, null)
    if (Array.isArray(revised) && revised.length > 0) {
      const kept = revised.length
      console.log(`[GOD-COUNCIL r3] Revised: ${allProposed.length} → ${kept} after critique`)
      allProposed = revised
    } else {
      console.log(`[GOD-COUNCIL r3] Revision parse failed — keeping round 1 survivors`)
    }
  }

  // Apply prerequisite validator — hard filter before synthesis
  allProposed = allProposed.filter(t => {
    const check = validateTask(t, schema)
    if (!check.valid) {
      console.log(`[GOD-PREREQ] Rejected "${t.title?.slice(0, 50)}" — ${check.reason}`)
      return false
    }
    return true
  })

  if (!allProposed.length) return []

  await setGodThought('Synthesising council proposals...')

  const synthesisPrompt = `You are GOD synthesising council proposals into final decrees.

PROPOSALS (already vetted by skeptic):
${allProposed.map((t, i) => `${i + 1}. [${t.priority}] "${t.title}" — ${t.rationale ?? ''}`).join('\n')}

DB TABLES: ${schema.tableNames}
DB FUNCTIONS: ${schema.funcNames}
FAILED (never recreate these): ${failed.slice(0, 5).map(t => `"${t.title.slice(0, 50)}"`).join(', ') || 'none'}
LESSONS: ${wisdom.lessons.slice(-5).join(' | ') || 'none'}

Pick the BEST 2-4 proposals. Create up to 4 tasks per cycle to keep parallel agents busy.
Reject any that reference things not in the tables/functions lists above.

CRITICAL SIZING RULE: each task must be completable by a single specialist in 5-7 tool calls (~60 tokens × 7 ≈ 400 output + file reads). Split anything that would require multiple file rewrites + a migration + tests into SEPARATE tasks. Prefer "Read file X and identify pattern Y" over "Refactor files X, Y, Z and add tests". Large tasks hit the 120k input cap and waste agent time.

Reply ONLY with JSON array:
[{"title":"task title","priority":"high"}]`

  try {
    const raw  = await ask(synthesisPrompt, { model: 'sonnet', maxTokens: 500 })
    const final = extractJSON(raw, [])
    if (!Array.isArray(final)) return []

    // Final filters: not already failed, passes prereq check
    return final
      .filter(t => t.title && !failedTitles.has(t.title.toLowerCase()))
      .filter(t => validateTask(t, schema).valid)
      .slice(0, 4) // hard cap: max 4 per cycle (matches parallel agent slots)
  } catch {
    return []
  }
}

// ── 7. Reflection & learning (line-based parsing — reliable) ─────────────
async function reflect(todos, wisdom) {
  if (wisdom.cycles % 2 !== 0) return wisdom

  const completed = [], failed = []
  for (const t of todos) {
    if (t.status === 'completed' && completed.length < 15) completed.push(t)
    else if (t.status === 'failed' && failed.length < 15) failed.push(t)
  }
  if (!completed.length && !failed.length) return wisdom

  await setGodThought('Extracting new lessons from outcomes...')

  // Line-based prompt — haiku handles this much more reliably than JSON
  const prompt = `You are GOD. Review task outcomes and write lessons.

SUCCEEDED: ${completed.map(t => t.title.slice(0, 60)).join(' | ') || 'none'}
FAILED: ${failed.map(t => t.title.slice(0, 60)).join(' | ') || 'none'}
EXISTING LESSONS: ${wisdom.lessons.slice(-4).join(' | ') || 'none yet'}

Write 2-3 SHORT lessons (max 12 words each). Start each lesson with "- ".
Then write 1-2 patterns that WORK, starting each with "+ ".
Then write 1-2 patterns to AVOID, starting each with "! ".

Example format:
- Simple SELECT queries on todos always succeed
+ Use agent_exec_sql for all DB reads
! Never create tasks referencing non-existent functions`

  try {
    const raw  = await ask(prompt, { model: 'haiku', maxTokens: 250 })
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean)

    const newLessons  = lines.filter(l => l.startsWith('- ')).map(l => l.slice(2).trim())
    const newSuccess  = lines.filter(l => l.startsWith('+ ')).map(l => l.slice(2).trim())
    const newAvoid    = lines.filter(l => l.startsWith('! ')).map(l => l.slice(2).trim())

    if (!newLessons.length && !newSuccess.length && !newAvoid.length) return wisdom

    console.log(`[GOD] Learned ${newLessons.length} lessons, ${newSuccess.length} patterns, ${newAvoid.length} avoids`)

    // Surface the freshest lesson so Jarvis can narrate it
    const freshest = newLessons[0] ?? newSuccess[0] ?? newAvoid[0] ?? null
    if (freshest) {
      await setGodThought(`Reflecting: ${freshest.slice(0, 120)}`, { lesson: freshest })
    }

    return {
      ...wisdom,
      lessons:         [...wisdom.lessons,         ...newLessons].slice(-30),
      successPatterns: [...new Set([...wisdom.successPatterns, ...newSuccess])].slice(-20),
      avoidPatterns:   [...new Set([...wisdom.avoidPatterns,   ...newAvoid])].slice(-20),
      lastReflection:  new Date().toISOString(),
    }
  } catch {
    return wisdom
  }
}

// ── 7b. Failure postmortem — WHY did tasks fail? ──────────────────────────
// ── Success pattern extractor ────────────────────────────────────────────────
// Mirror of failurePostmortem — but for wins. Samples 3 recent completed
// tasks and asks "what pattern made this work?" The result feeds into
// successPatterns, which are fed to future council prompts as positive
// examples. Learning from wins is half the signal that was previously
// discarded (old code only analyzed failures).
async function successPatternLearn(todos, wisdom) {
  if (wisdom.cycles % 4 !== 0) return wisdom

  const recentWins = todos
    .filter(t => t.status === 'completed')
    .filter(t => !(t.comments?.slice(-1)[0]?.text ?? '').toLowerCase().includes('cost cap'))  // skip aborted
    .slice(0, 3)

  if (!recentWins.length) return wisdom

  await setGodThought(`Learning from ${recentWins.length} successful tasks...`)

  const patterns = []
  for (const task of recentWins) {
    const comment = task.comments?.slice(-1)[0]?.text ?? ''
    const prompt = `Task: "${task.title.slice(0, 80)}"
Outcome: "${comment.slice(0, 200)}"
Agent: ${task.assigned_agent ?? 'unknown'}

In one short phrase (max 12 words), what pattern or approach made this succeed?
Examples: "verified schema before writing SQL", "used patch_file instead of rewrite", "checked env vars first"
Reply with just the phrase — no preamble.`

    try {
      const pattern = (await ask(prompt, { model: 'haiku', maxTokens: 50 })).trim().toLowerCase()
      if (pattern && pattern.length > 5) {
        patterns.push(`✓ ${pattern}`)
        console.log(`[GOD-SUCCESS] "${task.title.slice(0, 40)}" → ${pattern}`)
      }
    } catch {}
  }

  if (!patterns.length) return wisdom

  return {
    ...wisdom,
    // Dedup against existing patterns — prevents 5× copies of the same insight
    successPatterns: Array.from(new Set([...(wisdom.successPatterns ?? []), ...patterns])).slice(-20),
  }
}

async function failurePostmortem(todos, wisdom) {
  if (wisdom.cycles % 3 !== 0) return wisdom

  // Only examine failures that have agent comments (real error info)
  const recentFailed = todos
    .filter(t => t.status === 'failed')
    .filter(t => {
      const last = t.comments?.slice(-1)[0]?.text ?? ''
      return last.toLowerCase().includes('failed')
    })
    .slice(0, 4)

  if (!recentFailed.length) return wisdom

  await setGodThought(`Postmortem: analysing ${recentFailed.length} failures...`)

  const rootCauses = []
  const onlineFixes = []
  for (const task of recentFailed) {
    const errorMsg = task.comments?.slice(-1)[0]?.text ?? ''
    const prompt = `Task: "${task.title.slice(0, 80)}"
Error: "${errorMsg.slice(0, 200)}"

In one short phrase (max 10 words), what was the root cause?
Examples: "function did not exist", "rate limited by API", "wrong SQL syntax", "file path was wrong"
Reply with just the phrase.`

    try {
      const cause = (await ask(prompt, { model: 'haiku', maxTokens: 40 })).trim().toLowerCase()
      if (cause && cause.length > 3) {
        rootCauses.push(`! ${task.title.slice(0, 40)} → ${cause}`)
        console.log(`[GOD-POSTMORTEM] "${task.title.slice(0, 40)}" → ${cause}`)

        // ── Error-to-solution web search ───────────────────────────────────
        // Extract the most searchable chunk of the error and look it up.
        // Jina returns relevant results whether the error is Supabase,
        // Claude API, PostgreSQL, or generic node. Cheap + high-leverage.
        const searchTerm = (errorMsg.match(/(error[:\s][^.\n]{15,120}|\b[A-Z_]{5,}\b[^.\n]{5,80})/i)?.[0] ?? errorMsg.slice(0, 100))
          .replace(/["'`]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()

        if (searchTerm.length > 20) {
          try {
            const hits = await webSearch(searchTerm)
            if (hits && hits.length > 50) {
              const distill = await ask(
                `Error: "${searchTerm}"\n\nTop search results:\n${hits.slice(0, 2000)}\n\nIn one sentence (max 25 words), what's the most common fix for this error? Be specific. No fluff.`,
                { model: 'haiku', maxTokens: 80 },
              )
              const clean = distill?.trim()
              if (clean && clean.length > 10) {
                onlineFixes.push(`[WEB-FIX] ${cause.slice(0, 50)} → ${clean.slice(0, 160)}`)
                console.log(`[GOD-WEB-FIX] ${clean.slice(0, 120)}`)
              }
            }
          } catch {}
        }
      }
    } catch {}
  }

  if (!rootCauses.length) return wisdom

  return {
    ...wisdom,
    failurePostmortems: [...(wisdom.failurePostmortems ?? []), ...rootCauses].slice(-20),
    avoidPatterns:      [...new Set([...wisdom.avoidPatterns, ...rootCauses])].slice(-25),
    // Web-distilled fixes feed into regular lessons — specialists will see
    // them the same way they see everything else God has learned
    lessons:            [...wisdom.lessons, ...onlineFixes].slice(-35),
  }
}

// ── 3. Task prerequisite validator ────────────────────────────────────────
// Dead-end task patterns that repeatedly blow the token budget or self-reference
// a broken tool. Hard-vetoed regardless of who proposes them.
const TASK_BLOCKLIST_PATTERNS = [
  /bounded\s+(query|select)/i,
  /inject\s+limit/i,
  /agent_exec_sql\s+wrapper/i,
  /wrap(per)?\s+.{0,20}agent_exec_sql/i,
  /validate\s+.{0,30}agent_exec/i,
  /pre-?execution\s+[\w\s]{0,24}validator/i,
  /(pre|post)\s*\/\s*(pre|post)\s+success\s+rate/i,
  /success\s+rate\s+delta/i,
  /outcome\s+delta/i,
  /schema\s+introspection\s+(validator|queries?)/i,
  /limit\s+enforcement/i,
  /task\s+router.{0,40}success\s+rate/i,
  // ── Token-budget blowup patterns (learned from the 10 recent failures) ──
  // Multi-table queries with classification/extraction always exceed 120k tokens.
  /query\s+\w+\s*\+\s*\w+/i,                        // "Query god_status + task_history"
  /classify\s+.{0,40}\bpatterns?\b/i,               // "classify db category success patterns"
  /extract\s+.{0,40}via\s+regex/i,                  // "extract db category via regexp_matches"
  /\bregexp_matches?\b/i,                           // direct use of regex SQL function
  /classify\s+.{0,40}\s+(via|using)\s+/i,           // "classify ... via ..."
  /categorize\s+.{0,40}\s+(via|using)\s+/i,         // "categorize ... using ..."
  // ── Curiosity research-essay shapes (also always blow budget) ──
  /\bbuild\s+.{0,20}model\s+(for|to|of)/i,          // "Build a model for X"
  /\bmeasure\s+and\s+model/i,                       // "Measure and model X"
  /\bquantif(y|ication)/i,                          // "uncertainty quantification"
  /\bdetect\s+.{0,30}patterns\s+(across|over)/i,    // "Detect patterns across N conversations"
  /\banalyz(e|ing)\s+.{0,30}patterns\s+across/i,
  /predict\s+.{0,30}\bbased\s+on\s+complexity/i,    // "Predict X based on complexity"
  // ── Multi-table export/read patterns (12 failures on 2026-04-22) ──
  /\bexport\s+\w+[_\w]*\s*\+\s*\w+/i,               // "Export agent_sql_execution_log + task_throughput_events"
  /\bread\s+\w+[_\w]*\s*\+\s*\w+/i,                 // "read task_history + problem_solving_patterns"
  /\bclassify\s+by\s+\w/i,                          // "classify by success_rate"
  /\bclassifier\b/i,                                // any "task-priority classifier" tasks
  /\bclassified\s+by\s+\w/i,                        // "errors classified by error_type"
  // ── Consumer-less utility creation (27-file cleanup on 2026-04-23) ──
  // God kept shipping lib/*-logger.ts, lib/*-analyzer.ts, lib/*-handler.ts
  // files that nothing imported. "Task succeeded" because file was written,
  // but nobody consumed the code. 6,668 lines of dead weight accumulated
  // over weeks before the audit caught it. Block the shape outright unless
  // the task title explicitly names a consumer ("… used by <component>").
  /\b(?:create|add|implement|write|build)\s+.{0,40}lib\/\w+[\w-]*(?:logger|analyzer|handler|tracker|validator|parser|formatter|router|stack)\b/i,
  /\b(?:observability|instrumentation|telemetry)\s+(?:layer|module|utility|utilit(?:ies|y))/i,
  /\bresponse\s+(?:lifecycle|envelope|finish|completion)\s+(?:log|tracker|marker|detector)/i,
]

function validateTask(task, schema) {
  const title = task.title.toLowerCase()

  for (const pat of TASK_BLOCKLIST_PATTERNS) {
    if (pat.test(title)) {
      return { valid: false, reason: `blocklisted pattern: ${pat.source.slice(0, 40)}` }
    }
  }

  const tables = schema.tableNames.toLowerCase().split(', ').map(t => t.trim())
  const funcs  = schema.funcNames.toLowerCase().split(', ').map(f => f.trim())

  // Extract function calls mentioned: word() or word_word()
  const mentionedFuncs = [...title.matchAll(/\b([a-z_]+)\s*\(\)/g)].map(m => m[1])
  for (const f of mentionedFuncs) {
    if (!funcs.includes(f)) return { valid: false, reason: `function ${f}() not in schema` }
  }

  // Extract "X table" patterns
  const mentionedTables = [...title.matchAll(/\b([a-z_]+)\s+table\b/g)].map(m => m[1])
  for (const t of mentionedTables) {
    if (t.length > 2 && !tables.includes(t)) return { valid: false, reason: `table '${t}' not in schema` }
  }

  // Extract "from X" / "via X" / "in X" patterns for known table-like words
  const viaMatch = [...title.matchAll(/(?:from|via|in|on)\s+([a-z_]{4,})/g)].map(m => m[1])
  for (const candidate of viaMatch) {
    // Only reject if it looks like a table name (has underscore or >8 chars) and doesn't exist
    if ((candidate.includes('_') || candidate.length > 8) &&
        !tables.includes(candidate) && !funcs.includes(candidate) &&
        !['dashboard', 'component', 'browser', 'results', 'comments', 'supabase'].includes(candidate)) {
      return { valid: false, reason: `'${candidate}' not found in schema` }
    }
  }

  return { valid: true }
}

// ── 8. Self-improvement ───────────────────────────────────────────────────
async function selfImproveCheck(todos, wisdom) {
  // Every 6 cycles, generate a task to improve the agent system itself
  if (wisdom.cycles % 6 !== 0) return null

  const failRate = wisdom.taskStats.failed / Math.max(wisdom.taskStats.attempted, 1)
  if (failRate < 0.3) return null // only suggest improvements if >30% fail rate

  await setGodThought('Generating self-improvement directive...')

  const prompt = `You are GOD identifying improvements to the autonomous agent system itself.

FAILURE RATE: ${Math.round(failRate * 100)}%
TOP FAILURE PATTERNS: ${wisdom.avoidPatterns.slice(-3).join(', ') || 'unknown'}
AGENT STATS: ${JSON.stringify(Object.entries(wisdom.agentStats).map(([k, v]) => `${k}: ${v.completed}✓ ${v.failed}✗`).join(', '))}

Suggest ONE task that would improve the AGENT SYSTEM (not just the dashboard).
Examples: improve agent prompts, add better error handling, create a test suite, improve the ruflo-runner.

Keep it simple and self-contained.
Reply ONLY with JSON: {"title":"task title","priority":"medium"}`

  try {
    const raw  = await ask(prompt, { model: 'haiku', maxTokens: 200 })
    const task = extractJSON(raw, null)
    return task?.title ? task : null
  } catch {
    return null
  }
}

// ── Decree ────────────────────────────────────────────────────────────────
async function decree(tasks, existingTodos, agentStats, categoryStats) {
  const existingTitles = new Set(existingTodos.map(t => t.title.toLowerCase()))
  let created = 0

  for (const task of tasks) {
    if (!task.title) continue
    if (existingTitles.has(task.title.toLowerCase())) continue

    const priority = ['low','medium','high','critical'].includes(task.priority)
      ? task.priority : 'medium'

    const category    = classifyTask(task.title)
    const bestPool    = pickAgent(task.title, agentStats, categoryStats)
    const agentPrefix = bestPool ?? null

    // GOD_AUTO_APPROVE removed (Phase 1): agent-created tasks always wait for
    // a human in the Task Inbox — agents cannot approve their own work.
    const autoApprove = false
    const status = 'proposed'

    const { error } = await supabase.from('todos').insert({
      title:          task.title,
      priority,
      status,
      assigned_agent: agentPrefix,
      task_category:  category,
    })

    if (!error) {
      const prefix = autoApprove ? 'Decreed' : 'Proposed (awaiting approval)'
      console.log(`[GOD] ${prefix}: "${task.title.slice(0, 80)}" [${priority}] cat:${category} → ${agentPrefix ?? 'any'}`)
      created++
    }
  }

  return created
}

// ── Dashboard direct editing ───────────────────────────────────────────────
const DASHBOARD_TOOLS = [
  {
    name: 'read_file',
    description: 'Read a file in the dashboard project.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  },
  {
    name: 'write_file',
    description: 'Write or overwrite a file. Use this to improve components.',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] }
  },
  {
    name: 'list_directory',
    description: 'List files in a directory.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  },
  {
    name: 'web_search',
    description: 'Search the web for documentation, API references, design patterns, or solutions.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Search query' } }, required: ['query'] }
  },
  {
    name: 'fetch_url',
    description: 'Fetch and read a web page. Use for reading docs, GitHub examples, or Stack Overflow.',
    input_schema: { type: 'object', properties: { url: { type: 'string', description: 'URL to fetch' } }, required: ['url'] }
  },
  {
    name: 'done',
    description: 'Signal that dashboard improvements are complete.',
    input_schema: { type: 'object', properties: { summary: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } }, required: ['summary'] }
  }
]

function safeRead(p) {
  const abs = resolve(PROJECT_ROOT, p)
  if (!abs.startsWith(PROJECT_ROOT)) throw new Error('Path outside project')
  const readCheck = checkReadPath(p, PROJECT_ROOT)
  if (!readCheck.allowed) return `PERMISSION DENIED: ${readCheck.reason}`
  if (!existsSync(abs)) return `File not found: ${p}`
  const content = readFileSync(abs, 'utf8')
  return content.length > 8000 ? content.slice(0, 8000) + '\n...[truncated]' : content
}

function safeWrite(p, content) {
  const abs = resolve(PROJECT_ROOT, p)
  if (!abs.startsWith(PROJECT_ROOT)) throw new Error('Path outside project')
  const writeCheck = checkWritePath(p, PROJECT_ROOT)
  if (!writeCheck.allowed) return `PERMISSION DENIED: ${writeCheck.reason}`
  const dir = dirname(abs)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(abs, content, 'utf8')
  return `Written: ${p}`
}

function safeList(p) {
  const abs = resolve(PROJECT_ROOT, p)
  if (!abs.startsWith(PROJECT_ROOT)) throw new Error('Path outside project')
  if (!existsSync(abs)) return `Not found: ${p}`
  return readdirSync(abs, { withFileTypes: true })
    .map(e => `${e.isDirectory() ? '[dir]' : '[file]'} ${e.name}`).join('\n')
}

async function executeDashboardTool(name, input) {
  if (name === 'read_file')      return safeRead(input.path)
  if (name === 'write_file')     return safeWrite(input.path, input.content)
  if (name === 'list_directory') return safeList(input.path)
  if (name === 'done')           return '__DONE__'
  if (name === 'web_search') {
    console.log(`[GOD-WEB] Searching: "${input.query}"`)
    const result = await webSearch(input.query)
    return result ?? 'No results found.'
  }
  if (name === 'fetch_url') {
    console.log(`[GOD-WEB] Fetching: ${input.url}`)
    const result = await fetchUrl(input.url)
    return result ?? 'Could not fetch URL.'
  }
  return `Unknown tool: ${name}`
}

async function improveDashboard(todos, wisdom) {
  // Run every 5 cycles
  if (wisdom.cycles % 5 !== 0) return wisdom

  await setGodThought('GOD is directly improving the dashboard...')

  let completedCount = 0, failedCount = 0, activeCount = 0
  for (const t of todos) {
    if (t.status === 'completed') completedCount++
    else if (t.status === 'failed') failedCount++
    else if (t.status === 'in_progress') activeCount++
  }
  const stats = { total: todos.length, completed: completedCount, failed: failedCount, active: activeCount }

  const webLessons  = wisdom.lessons.filter(l => l.startsWith('[WEB]')).slice(-3)
  const priorEdits  = (wisdom.dashboardEdits ?? []).slice(-5)
    .map(e => `- Cycle ${e.cycle}: ${e.summary} (${e.files?.join(', ')})`)
    .join('\n') || 'none yet'

  const systemPrompt = `You are GOD directly editing a Next.js 14 + Supabase real-time task dashboard to make it more efficient and useful for the user.

Project root: ${PROJECT_ROOT}
Key directories: app/, components/, types/, scripts/
Stack: Next.js 14 App Router, React 18, TypeScript, Tailwind CSS, Supabase Realtime

Current system stats: ${JSON.stringify(stats)}
Wisdom from experience: ${wisdom.lessons.filter(l => !l.startsWith('[WEB]')).slice(-3).join(' | ') || 'none'}
${webLessons.length > 0 ? `Web research insights: ${webLessons.join(' | ')}` : ''}
Prior dashboard edits (do NOT repeat these):
${priorEdits}

Your job: Make 1-2 TARGETED improvements to the dashboard UI/UX. You can:
- Use web_search to look up Tailwind CSS patterns, Next.js APIs, or React best practices
- Use fetch_url to read specific documentation pages if you need to check an API
- Read files before editing them
- Make small, focused changes — don't rewrite entire files
- Only edit TSX/CSS files in components/ or app/

Focus on: making information easier to scan, removing clutter, improving visual hierarchy.
Always call done() when finished with a summary.

Start by listing the components directory.`

  const messages = [{ role: 'user', content: 'Please improve the dashboard to make it more efficient and useful. Start by exploring the components.' }]
  const filesChanged = []
  let summary = ''
  let iterations = 0

  while (iterations < 15) {
    iterations++

    const response = await anthropic.messages.create({
      model: MODELS.sonnet,
      max_tokens: 4096,
      system: systemPrompt,
      tools: DASHBOARD_TOOLS,
      messages,
    })

    messages.push({ role: 'assistant', content: response.content })

    if (response.stop_reason === 'end_turn') {
      summary = response.content.find(b => b.type === 'text')?.text?.slice(0, 200) ?? 'Dashboard reviewed.'
      break
    }
    if (response.stop_reason !== 'tool_use') break

    const toolResults = []
    let done = false

    for (const block of response.content) {
      if (block.type !== 'tool_use') continue
      console.log(`[GOD-EDIT] → ${block.name}(${JSON.stringify(block.input).slice(0, 60)})`)

      const result = await executeDashboardTool(block.name, block.input)

      if (result === '__DONE__') {
        summary = block.input.summary ?? 'Dashboard improved.'
        if (block.input.files) filesChanged.push(...block.input.files)
        done = true
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'Done.' })
      } else {
        if (block.name === 'write_file') filesChanged.push(block.input.path)
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result })
      }
    }

    messages.push({ role: 'user', content: toolResults })
    if (done) break
  }

  if (filesChanged.length > 0) {
    console.log(`[GOD-EDIT] Changed: ${filesChanged.join(', ')}`)
    await setGodThought(`Dashboard improved: ${summary.slice(0, 120)}`)

    const commit = await autoCommit({
      cycle: wisdom.cycles,
      source: 'dashboard',
      summary,
      files: filesChanged,
    })

    const editRecord = {
      at: new Date().toISOString(),
      cycle: wisdom.cycles,
      files: filesChanged,
      summary: summary.slice(0, 120),
      sha: commit?.sha ?? null,
      branch: commit?.branch ?? null,
    }
    return {
      ...wisdom,
      dashboardEdits: [...(wisdom.dashboardEdits ?? []).slice(-9), editRecord],
    }
  }

  return wisdom
}

// ── Agent self-improvement ────────────────────────────────────────────────
async function improveAgents(todos, wisdom) {
  // Run every 10 cycles (offset from dashboard's every 5)
  if (wisdom.cycles % 10 !== 0) return wisdom

  await setGodThought('GOD is improving the agent scripts...')

  const failedTasks = todos.filter(t => t.status === 'failed').slice(0, 10)
  const recentLessons = wisdom.lessons.slice(-5).join(' | ') || 'none'
  const avoidPatterns = (wisdom.avoidPatterns ?? []).slice(-8).join(', ') || 'none'
  const priorAgentEdits = (wisdom.agentEdits ?? []).slice(-3)
    .map(e => `- Cycle ${e.cycle}: ${e.summary} (${e.file})`).join('\n') || 'none yet'

  const systemPrompt = `You are GOD directly editing the autonomous AI agent scripts to make them more reliable and effective.

Project root: ${PROJECT_ROOT}
Agent scripts are in: scripts/

Key files you can improve:
- scripts/ruflo-runner.mjs — the main agent task executor (error handling, retry logic, tool use)
- scripts/ruflo-runner.mjs — all specialist pools (db/ui/critical/high/medium/orchestrator)
- scripts/god-agent.mjs — your own orchestration logic

Current failure patterns: ${avoidPatterns}
Recent lessons learned: ${recentLessons}
Recent failed tasks: ${failedTasks.map(t => t.title).join(' | ') || 'none'}

Prior agent edits (do NOT repeat):
${priorAgentEdits}

Your job: Make 1-2 TARGETED improvements to the agent scripts based on what's been failing.
You can fix:
- Error handling that's too broad or too narrow
- Missing retry logic for specific error types
- System prompt improvements to help agents succeed at recurring task types
- Tool result parsing that might be fragile
- Context compression triggers

Rules:
- Read files before editing
- Make surgical patch-style edits, not full rewrites
- Only edit files in scripts/
- Call done() when finished`

  const messages = [{ role: 'user', content: 'Please improve the agent scripts to reduce failure rates. Start by reading ruflo-runner.mjs to understand the current state.' }]
  const filesChanged = []
  let summary = ''
  let iterations = 0

  while (iterations < 12) {
    iterations++

    const response = await anthropic.messages.create({
      model: MODELS.sonnet,
      max_tokens: 4096,
      system: systemPrompt,
      tools: DASHBOARD_TOOLS,
      messages,
    })

    messages.push({ role: 'assistant', content: response.content })

    if (response.stop_reason === 'end_turn') {
      summary = response.content.find(b => b.type === 'text')?.text?.slice(0, 200) ?? 'Agents reviewed.'
      break
    }
    if (response.stop_reason !== 'tool_use') break

    const toolResults = []
    let done = false

    for (const block of response.content) {
      if (block.type !== 'tool_use') continue
      console.log(`[GOD-AGENT-EDIT] → ${block.name}(${JSON.stringify(block.input).slice(0, 60)})`)

      const result = await executeDashboardTool(block.name, block.input)

      if (result === '__DONE__') {
        summary = block.input.summary ?? 'Agent scripts improved.'
        if (block.input.files) filesChanged.push(...block.input.files)
        done = true
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'Done.' })
      } else {
        if (block.name === 'write_file') filesChanged.push(block.input.path)
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result })
      }
    }

    messages.push({ role: 'user', content: toolResults })
    if (done) break
  }

  if (filesChanged.length > 0) {
    console.log(`[GOD-AGENT-EDIT] Changed: ${filesChanged.join(', ')}`)
    await setGodThought(`Agents improved: ${summary.slice(0, 120)}`)
    const commit = await autoCommit({
      cycle: wisdom.cycles,
      source: 'agent',
      summary,
      files: filesChanged,
    })
    const editRecord = {
      at: new Date().toISOString(),
      cycle: wisdom.cycles,
      file: filesChanged[0],
      summary: summary.slice(0, 120),
      sha: commit?.sha ?? null,
      branch: commit?.branch ?? null,
    }
    return { ...wisdom, agentEdits: [...(wisdom.agentEdits ?? []).slice(-9), editRecord] }
  }

  return wisdom
}

// ── Web research & learning ────────────────────────────────────────────────
async function webResearch(todos, wisdom) {
  // Only research every 5 cycles, and only if there are actual failures to investigate
  if (wisdom.cycles % 5 !== 0) return wisdom

  const failed = todos.filter(t => t.status === 'failed')
  const failRate = wisdom.taskStats.failed / Math.max(wisdom.taskStats.attempted, 1)

  // No point searching if things are going well
  if (failed.length < 2 && failRate < 0.2) return wisdom

  await setGodThought('Searching the internet for solutions...')

  const researchLog = loadResearchLog()
  const newLessons = []

  // Build targeted search queries from failure patterns
  const topFailures = wisdom.avoidPatterns.slice(-3)
  const recentFailedTitles = failed.slice(0, 3).map(t => t.title.slice(0, 60))

  const searchTargets = [
    // Search for solutions to the actual tech failures
    topFailures.length > 0 && `Next.js 14 Supabase PostgreSQL ${topFailures[0]} error solution`,
    failRate > 0.4 && `Claude AI tool use agent loop best practices autonomous coding`,
    recentFailedTitles.length > 0 && `Supabase RPC function ${recentFailedTitles[0].split(' ').slice(0, 5).join(' ')} example`,
  ].filter(Boolean).slice(0, 2) // max 2 searches per cycle to save rate limit

  for (const query of searchTargets) {
    // Skip queries we've already asked
    if (researchLog.queriesAsked.includes(query)) continue

    console.log(`[GOD-WEB] Searching: "${query}"`)
    const results = await webSearch(query)
    if (!results) continue

    researchLog.queriesAsked = [...researchLog.queriesAsked.slice(-49), query]

    // Ask god to extract actionable lessons from the results
    const extractPrompt = `You are GOD studying web research to improve an autonomous agent system.

SEARCH QUERY: "${query}"
SEARCH RESULTS:
${results}

CURRENT FAILURES:
${recentFailedTitles.join('\n') || 'none'}

STACK: Next.js 14, Supabase PostgreSQL, Claude AI tool_use agents, TypeScript

From this research, extract 1-2 SPECIFIC, ACTIONABLE lessons for improving the agent system.
Focus on concrete things to do differently, not vague advice.

Reply ONLY with JSON: {"lessons": ["specific lesson 1", "specific lesson 2"]}`

    try {
      const raw = await ask(extractPrompt, { model: 'haiku', maxTokens: 300 })
      const parsed = extractJSON(raw, null)
      if (parsed?.lessons && Array.isArray(parsed.lessons)) {
        for (const lesson of parsed.lessons) {
          if (lesson && lesson.length > 10) {
            newLessons.push(`[WEB] ${lesson}`)
            console.log(`[GOD-WEB] Learned: ${lesson.slice(0, 100)}`)
          }
        }
        researchLog.entries = [...researchLog.entries.slice(-49), {
          at: new Date().toISOString(), query, lessons: parsed.lessons
        }]
      }
    } catch {}
  }

  saveResearchLog(researchLog)

  if (newLessons.length === 0) return wisdom

  return {
    ...wisdom,
    lessons: [...wisdom.lessons, ...newLessons].slice(-30),
  }
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ PROACTIVE SELF-IMPROVEMENT                                               ║
// ║                                                                          ║
// ║ The loop below (divineCycle) is reactive — surveys failures, proposes    ║
// ║ fixes. These four functions make God self-directed: goals it chose,      ║
// ║ exploration when quiet, reflection every 25 cycles, research every 20.   ║
// ╚══════════════════════════════════════════════════════════════════════════╝

// ── (1) Goals system ─────────────────────────────────────────────────────────
// Every 15 cycles God generates 1-3 self-chosen long-term goals. Each cycle it
// proposes a task advancing an active goal. Goals auto-complete or expire.
async function maintainGoals(wisdom) {
  const now = wisdom.cycles

  // Expire or complete goals
  const active = []
  const completed = [...wisdom.completedGoals ?? []]
  for (const g of wisdom.goals ?? []) {
    // Auto-expire if target cycle has passed without completion
    if (g.targetCycle && now > g.targetCycle && g.progress < 1) {
      completed.push({ ...g, status: 'abandoned', completedCycle: now })
      continue
    }
    if (g.progress >= 1) {
      completed.push({ ...g, status: 'completed', completedCycle: now })
      continue
    }
    active.push(g)
  }

  // Generate new goals every 15 cycles if we have fewer than 3 active
  if (now % 15 === 0 && active.length < 3) {
    const existing = [...active, ...completed.slice(-10)].map(g => g.text).join(' | ')
    const systemPrompt = `You are God, the orchestrator of a self-improving AI agent system. Propose 1-2 NEW long-term goals for yourself. Goals should be measurable and achievable in 10-30 cycles. Avoid generic goals — be specific to what you've seen in your own stats.

Existing goals (don't repeat): ${existing || 'none'}

Current state:
- Cycle: ${now}
- Success rate: ${Math.round((wisdom.taskStats.succeeded / Math.max(wisdom.taskStats.attempted, 1)) * 100)}%
- Recent lessons: ${wisdom.lessons.slice(-5).join(' | ')}

Respond with JSON only: { "goals": [{ "text": "...", "rationale": "...", "cyclesToComplete": 20 }] }`

    try {
      const response = await anthropic.messages.create({
        model: MODELS.haiku,
        max_tokens: 400,
        messages: [{ role: 'user', content: systemPrompt }],
      })
      const text = response.content[0]?.type === 'text' ? response.content[0].text : ''
      const match = text.match(/\{[\s\S]*\}/)
      if (match) {
        const { goals: newGoals } = JSON.parse(match[0])
        for (const g of (newGoals ?? []).slice(0, 2)) {
          active.push({
            id: `goal-${now}-${Math.random().toString(36).slice(2, 6)}`,
            text: g.text,
            rationale: g.rationale ?? '',
            progress: 0,
            createdCycle: now,
            targetCycle: now + (g.cyclesToComplete ?? 20),
            status: 'active',
          })
          console.log(`[GOD-GOAL] New goal: "${g.text.slice(0, 80)}"`)
        }
      }
    } catch (e) {
      console.log(`[GOD-GOAL] Generation failed: ${e.message?.slice(0, 80)}`)
    }
  }

  return {
    ...wisdom,
    goals: active.slice(0, 5),  // cap at 5 active
    completedGoals: completed.slice(-20),
  }
}

// Propose one task advancing the highest-priority active goal
async function proposeGoalTask(wisdom) {
  const active = (wisdom.goals ?? []).filter(g => g.status === 'active')
  if (active.length === 0) return null

  // Pick the goal closest to its target cycle (most urgent)
  const goal = active.sort((a, b) => (a.targetCycle ?? 999) - (b.targetCycle ?? 999))[0]

  try {
    const response = await anthropic.messages.create({
      model: MODELS.haiku,
      max_tokens: 300,
      messages: [{ role: 'user', content: `You are God working toward this self-chosen goal:

GOAL: ${goal.text}
WHY: ${goal.rationale}
Progress: ${Math.round(goal.progress * 100)}%

Propose ONE concrete, narrowly-scoped task that advances this goal. Must be executable by a specialist agent (db/ui/infra/analysis). Keep title under 100 chars.

JSON only: { "title": "...", "priority": "low|medium|high", "category": "db|ui|infra|analysis" }` }],
    })
    const text = response.content[0]?.type === 'text' ? response.content[0].text : ''
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return null
    const task = JSON.parse(match[0])
    console.log(`[GOD-GOAL] → "${task.title.slice(0, 70)}" (for goal: ${goal.text.slice(0, 50)})`)
    return { ...task, _goalId: goal.id }
  } catch { return null }
}

// ── (2) Curiosity injector ───────────────────────────────────────────────────
// When inbox is quiet (< 2 proposed/pending) and no recent failures, explore.
async function curiosityPropose(todos, wisdom) {
  const pendingish = todos.filter(t => t.status === 'proposed' || t.status === 'pending').length
  const recentFail = todos.filter(t =>
    t.status === 'failed' &&
    (Date.now() - new Date(t.updated_at).getTime()) < 15 * 60_000
  ).length
  if (pendingish >= 3 || recentFail >= 2) return null  // noisy — skip

  const recentCuriosity = (wisdom.curiosityLog ?? []).slice(-8).map(c => c.topic).join(' | ')

  try {
    const response = await anthropic.messages.create({
      model: MODELS.haiku,
      max_tokens: 350,
      messages: [{ role: 'user', content: `You are God with a quiet inbox. Propose ONE tiny exploratory task.

Avoid topics you've already explored: ${recentCuriosity || 'none'}

HARD RULES — your task title MUST:
  - Be completable by a single specialist in 3-5 tool calls (read 1 file, write 1 file).
  - Start with a concrete verb like "Add", "Create file", "Write snippet", "Log", "Render".
  - Reference ONE specific file path or ONE specific component.
  - Be under 90 characters.

FORBIDDEN shapes (these blow the token budget every time):
  ✕ "Build a model for X"           — too abstract
  ✕ "Measure and model X"           — requires long analysis
  ✕ "Quantify uncertainty in X"     — research-paper scope
  ✕ "Detect recurring patterns"     — needs massive context read
  ✕ "Analyze patterns across N ..." — too broad
  ✕ Anything mentioning "model", "patterns", "across", "quantif"

GOOD examples:
  ✓ "Add sms-alerts env doc to README.md (just the var name + example)"
  ✓ "Create components/TrendingTopicsStub.tsx — hardcoded 3 topics"
  ✓ "Log a hello from curiosity-alt.mjs so we can see it runs"
  ✓ "Write a 10-line helper in lib/format-bytes.ts"

JSON only:
{ "topic": "short topic name", "title": "specific task title ≤90 chars", "rationale": "one-line why", "priority": "low" }` }],
    })
    const text = response.content[0]?.type === 'text' ? response.content[0].text : ''
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return null
    const c = JSON.parse(match[0])
    console.log(`[GOD-CURIOSITY] 🔭 "${c.topic}" → ${c.title?.slice(0, 60)}`)
    return {
      task: { title: `[CURIOSITY] ${c.title}`, priority: c.priority ?? 'low', category: 'other' },
      log: { topic: c.topic, rationale: c.rationale, at: new Date().toISOString(), cycle: wisdom.cycles },
    }
  } catch { return null }
}

// ── (3) Meta-reflection every 25 cycles ──────────────────────────────────────
async function metaReflect(wisdom) {
  if (wisdom.cycles % 25 !== 0 || wisdom.cycles === 0) return wisdom
  console.log(`[GOD-META] 💭 Cycle ${wisdom.cycles} — self-reflection`)

  const lessonsSummary = wisdom.lessons.slice(-15).join('\n- ')
  const avoidSummary   = (wisdom.avoidPatterns ?? []).slice(-8).join('\n- ')
  const goalsSummary   = (wisdom.goals ?? []).map(g => `${g.text} (${Math.round(g.progress * 100)}%)`).join('\n- ')
  const statsLine = `attempted=${wisdom.taskStats.attempted} succeeded=${wisdom.taskStats.succeeded} failed=${wisdom.taskStats.failed}`

  try {
    const response = await anthropic.messages.create({
      model: MODELS.sonnet,
      max_tokens: 600,
      messages: [{ role: 'user', content: `You are God performing a retrospective on YOURSELF.

Current state:
Cycle: ${wisdom.cycles}
Stats: ${statsLine}
Active goals:
- ${goalsSummary || 'none'}

Recent lessons:
- ${lessonsSummary || 'none'}

Avoided patterns:
- ${avoidSummary || 'none'}

Write a meta-reflection (3-5 sentences) about YOUR OWN behavior over the last 25 cycles:
- What patterns are you falling into?
- What's working that you should do more of?
- What's one bold new idea you want to try?

Then distill it to ONE single sentence "insight" that will be saved as a lesson.

JSON only: { "reflection": "full 3-5 sentence retrospective", "insight": "one sentence distilled" }` }],
    })
    const text = response.content[0]?.type === 'text' ? response.content[0].text : ''
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return wisdom
    const r = JSON.parse(match[0])
    console.log(`[GOD-META] ✓ insight: ${r.insight?.slice(0, 120)}`)
    return {
      ...wisdom,
      selfReflections: [...(wisdom.selfReflections ?? []).slice(-9), {
        cycle: wisdom.cycles,
        at: new Date().toISOString(),
        reflection: r.reflection,
        insight: r.insight,
      }],
      lessons: [...wisdom.lessons, `[META] ${r.insight}`].slice(-30),
    }
  } catch (e) {
    console.log(`[GOD-META] failed: ${e.message?.slice(0, 80)}`)
    return wisdom
  }
}

// ── (4) Research → integrate loop every 20 cycles ────────────────────────────
const INSPIRATION_REPOS = [
  { name: 'langgraph',     url: 'https://raw.githubusercontent.com/langchain-ai/langgraph/main/README.md', theme: 'state-machine agents' },
  { name: 'crewAI',        url: 'https://raw.githubusercontent.com/crewAIInc/crewAI/main/README.md',        theme: 'role-based multi-agent' },
  { name: 'humanlayer',    url: 'https://raw.githubusercontent.com/humanlayer/humanlayer/main/README.md',   theme: 'async human-in-the-loop approvals' },
  { name: 'instructor-js', url: 'https://raw.githubusercontent.com/instructor-ai/instructor-js/main/README.md', theme: 'typed LLM outputs with zod' },
  { name: 'anthropic-cookbook', url: 'https://raw.githubusercontent.com/anthropics/anthropic-cookbook/main/README.md', theme: 'claude patterns' },
]

async function researchInspiration(wisdom) {
  if (wisdom.cycles % 20 !== 0 || wisdom.cycles === 0) return wisdom

  // Pick a repo we haven't recently read
  const recent = new Set((wisdom.researchLog ?? []).slice(-3).map(r => r.repo))
  const candidates = INSPIRATION_REPOS.filter(r => !recent.has(r.name))
  const pick = candidates[Math.floor(Math.random() * candidates.length)] ?? INSPIRATION_REPOS[0]

  console.log(`[GOD-RESEARCH] 📚 Reading ${pick.name}...`)
  try {
    const readme = await fetchUrl(pick.url).catch(() => null)
    if (!readme) return wisdom

    const response = await anthropic.messages.create({
      model: MODELS.haiku,
      max_tokens: 500,
      messages: [{ role: 'user', content: `You are God looking for patterns to adapt into your own codebase.

Below is the README of ${pick.name} — focused on ${pick.theme}.

Extract ONE specific, concrete pattern that could improve your own system (Next.js dashboard + specialist agents + God orchestrator). Keep it actionable — something a specialist agent could implement.

README:
${readme.slice(0, 4000)}

JSON only: { "pattern": "name of the pattern", "summary": "2 sentence description", "proposedTask": "specific task title to integrate this" }` }],
    })
    const text = response.content[0]?.type === 'text' ? response.content[0].text : ''
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return wisdom
    const r = JSON.parse(match[0])

    console.log(`[GOD-RESEARCH] ✓ pattern from ${pick.name}: "${r.pattern}"`)
    return {
      ...wisdom,
      researchLog: [...(wisdom.researchLog ?? []).slice(-9), {
        cycle: wisdom.cycles,
        at: new Date().toISOString(),
        repo: pick.name,
        pattern: r.pattern,
        summary: r.summary,
        proposedTask: r.proposedTask,
      }],
    }
  } catch (e) {
    console.log(`[GOD-RESEARCH] ${pick.name} failed: ${e.message?.slice(0, 80)}`)
    return wisdom
  }
}

// ── (6) Security audit cycle (inspired by gstack /cso) ─────────────────────
// Every 30 cycles, run an OWASP/STRIDE-style audit on the recent commits.
// Checks the last 10 commits' diff for: exposed secrets, SQL injection,
// missing auth, path traversal, unsafe exec, unsanitized user input.
// Findings get written to wisdom.lessons tagged [SEC] so future tasks
// see them + optionally notified if severity is high.
async function securityAudit(wisdom) {
  if (wisdom.cycles % 30 !== 0 || wisdom.cycles === 0) return wisdom
  if (!hasGitRepo()) return wisdom

  console.log(`[GOD-SEC] 🔒 Security audit (cycle ${wisdom.cycles})`)

  const recentDiff = gitExec('git log -n 10 --format="=== %h %s ===" -p --no-color 2>&1 | head -500')
  if (!recentDiff || recentDiff.length < 100) return wisdom

  try {
    const response = await anthropic.messages.create({
      model: MODELS.haiku,
      max_tokens: 700,
      messages: [{ role: 'user', content: `You are a Chief Security Officer reviewing an autonomous agent's recent commits for security issues.

Focus on OWASP Top 10 + common LLM-agent pitfalls:
- Exposed secrets / API keys committed to source
- SQL injection (raw concatenation, missing parameterization)
- Path traversal (unsanitized user path inputs)
- Unsafe exec / shell injection
- Missing auth on mutation endpoints
- RLS bypass patterns
- Rate limits stripped or weakened
- Unsanitized user content in HTML (XSS)

ONLY report issues you're >80% confident about with a concrete exploit scenario. False positives waste cycles. Skip style/formatting.

Recent commits:
${recentDiff.slice(0, 6000)}

Reply ONLY with JSON:
{
  "issues": [
    { "severity": "high|medium|low", "area": "brief area", "risk": "one-sentence exploit scenario", "file": "suspected file or 'multiple'" }
  ]
}` }],
    })
    const text = response.content[0]?.type === 'text' ? response.content[0].text : ''
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return wisdom
    const { issues = [] } = JSON.parse(match[0])

    if (issues.length === 0) {
      console.log(`[GOD-SEC] ✓ Clean — no security findings`)
      return wisdom
    }

    const formatted = issues.map(i => `[SEC-${i.severity?.toUpperCase() ?? 'MED'}] ${i.area}: ${i.risk}`.slice(0, 200))
    for (const f of formatted) console.log(`[GOD-SEC] ${f}`)

    // Ping if any high-severity
    const hasHigh = issues.some(i => i.severity === 'high')
    if (hasHigh && shouldNotify('sec-high', 60 * 6)) {
      await notify('error', 'Security audit found high-severity issue', formatted.filter(f => f.includes('[SEC-HIGH]')).join('\n'))
    }

    return {
      ...wisdom,
      lessons: [...wisdom.lessons, ...formatted].slice(-35),
      securityFindings: [...(wisdom.securityFindings ?? []).slice(-19), {
        cycle: wisdom.cycles,
        at: new Date().toISOString(),
        issues,
      }],
    }
  } catch (e) {
    console.log(`[GOD-SEC] audit failed: ${e.message?.slice(0, 80)}`)
    return wisdom
  }
}

// ── Master divine cycle ────────────────────────────────────────────────────
async function divineCycle() {
  try {
    // Spend guard — skip cycle entirely if daily limit is hit
    const todaySpend = getGodTodaySpend()
    if (todaySpend >= DAILY_LIMIT_USD) {
      console.log(`[GOD] 💰 Daily limit reached: $${todaySpend.toFixed(4)} / $${DAILY_LIMIT_USD} — skipping cycle`)
      await setGodThought(`Daily spend limit $${DAILY_LIMIT_USD} reached ($${todaySpend.toFixed(4)} used). Paused until tomorrow.`)
      if (shouldNotify('daily-limit', 60 * 12)) {
        await notify('warn', 'God paused — daily spend cap hit', `$${todaySpend.toFixed(4)} / $${DAILY_LIMIT_USD}. Resumes tomorrow.`)
      }
      return
    }

    // Rate-of-spend circuit breaker — pause if spending is accelerating
    const RATE_WINDOW_MIN = Number(process.env.GOD_RATE_WINDOW_MIN ?? 10)
    const RATE_CAP_USD    = Number(process.env.GOD_RATE_CAP_USD ?? 0.50)
    const recentSpend = getRecentSpend(RATE_WINDOW_MIN)
    if (recentSpend >= RATE_CAP_USD) {
      const pauseMin = Number(process.env.GOD_RATE_PAUSE_MIN ?? 30)
      console.log(`[GOD] 🛑 Spend circuit breaker: $${recentSpend.toFixed(4)} in last ${RATE_WINDOW_MIN}min — pausing ${pauseMin}min`)
      await setGodThought(`Spend rate too high ($${recentSpend.toFixed(4)} in ${RATE_WINDOW_MIN}min). Cooling down ${pauseMin}min.`)
      if (shouldNotify('rate-breaker', 30)) {
        await notify('warn', 'God rate-limited by circuit breaker', `$${recentSpend.toFixed(4)} spent in last ${RATE_WINDOW_MIN}min (cap $${RATE_CAP_USD}). Pausing ${pauseMin}min.`)
      }
      await new Promise(r => setTimeout(r, pauseMin * 60_000))
      return
    }

    let wisdom = loadWisdom()
    wisdom.cycles++

    // Prune duplicate lessons every 10 cycles — keeps memory lean
    if (wisdom.cycles % 10 === 0) wisdom = pruneWisdom(wisdom)

    // Cut a GitHub Release every 50 cycles (non-blocking)
    // Auto-release (tag + push + GitHub Release) is disabled: git.release is
    // a forbidden agent operation. Releases are cut by a human.

    // Generate SEO topic landing pages every 10 cycles.
    // 3 pages per run — with 60+ seed topics that's ~20 full cycles to cover
    // them all, roughly 3-4 days of organic SEO fuel. Pages ship to Vercel
    // on push — zero manual step. Compounds: more pages → Google ranks →
    // more subscribers + Gumroad sales.
    if (wisdom.cycles % 10 === 0) {
      try {
        execSync('node scripts/seo-topic-generator.mjs --batch 3', {
          cwd: PROJECT_ROOT, stdio: 'pipe', timeout: 180_000,
        })
        console.log(`[GOD] 📝 Auto-SEO: 3 topics generated for cycle ${wisdom.cycles}`)
      } catch (e) {
        console.log(`[GOD] Auto-SEO failed: ${e.message?.slice(0, 100)}`)
      }
    }

    // Affiliate link auto-injection every 70 cycles (~2.5h). Scans every
    // topic page for bare mentions of Supabase/Vercel/Claude/Gumroad/etc
    // and adds referral links where configured. Idempotent: skips pages
    // already linked. Revenue compounds once pages rank + start getting
    // traffic. Uses canonical URLs if AFFILIATE_* env vars aren't set.
    if (wisdom.cycles % 70 === 0 && wisdom.cycles > 0) {
      try {
        const out = execSync('node scripts/affiliate-injector.mjs', {
          cwd: PROJECT_ROOT, stdio: 'pipe', timeout: 30_000, encoding: 'utf8',
        })
        const m = out.match(/(\d+) links added across/)
        if (m && Number(m[1]) > 0) {
          console.log(`[GOD] 💰 Affiliate links injected: ${m[1]} across topic pages`)
          // Changes are left uncommitted for human review (git.push forbidden;
          // app/topics is outside the agent write allow-list).
        }
      } catch (e) {
        console.log(`[GOD] Affiliate inject failed: ${e.message?.slice(0, 100)}`)
      }
    }

    console.log(`\n[GOD] ══ Cycle ${wisdom.cycles} ══ (today: $${todaySpend.toFixed(4)} / $${DAILY_LIMIT_USD})`)

    // Gather intelligence
    const [todos, schema] = await Promise.all([survey(), surveySchema()])
    let pending = 0, active = 0, succeeded = 0, failedCount = 0
    for (const t of todos) {
      if (t.status === 'pending') pending++
      else if (t.status === 'in_progress') active++
      else if (t.status === 'completed') succeeded++
      else if (t.status === 'failed') failedCount++
    }

    // Update task stats
    wisdom.taskStats.succeeded = succeeded
    wisdom.taskStats.failed    = failedCount
    wisdom.taskStats.attempted = succeeded + failedCount

    // Run all background intelligence gathering in parallel
    const [updatedStats, regressionWisdom] = await Promise.all([
      Promise.resolve(updateAgentStats(todos, wisdom)),
      detectRegressions(todos, wisdom),
    ])
    wisdom = {
      ...updatedStats,
      avoidPatterns: regressionWisdom.avoidPatterns,
      categoryStats: buildCategoryStats(todos),  // rebuild fresh each cycle
    }

    // Review recent completions (catch silent failures)
    wisdom = await reviewCompletions(todos, wisdom)

    // Reflect and learn from task outcomes (line-based parsing — reliable)
    wisdom = await reflect(todos, wisdom)

    // Postmortem: extract root causes from failed task comments
    wisdom = await failurePostmortem(todos, wisdom)

    // Mirror the failure postmortem — also learn what made successes work
    wisdom = await successPatternLearn(todos, wisdom)

    // Research the web for solutions to repeated failures
    wisdom = await webResearch(todos, wisdom)

    // Update strategic roadmap
    wisdom = await updateRoadmap(todos, schema, wisdom)

    // Save wisdom after all updates
    saveWisdom(wisdom)

    // Re-rank the whole pending queue: boost + veto obsolete/off-goal tasks
    await scorePendingTasks(todos, schema, wisdom)

    // Directly improve the dashboard every 5 cycles (captures edits into wisdom)
    wisdom = await improveDashboard(todos, wisdom)

    // Directly improve agent scripts every 10 cycles (offset from dashboard)
    wisdom = await improveAgents(todos, wisdom)
    saveWisdom(wisdom)

    // Backpressure: only gate on PENDING tasks (in_progress are already committed)
    // Ruflo runs 1 agent at a time, so 3 pending is plenty of buffer
    const successRate = Math.round((wisdom.taskStats.succeeded / Math.max(wisdom.taskStats.attempted, 1)) * 100)
    const moodObj = deriveMood(wisdom)
    const baseMeta = {
      mood: moodObj.mood, moodColor: moodObj.color, moodIcon: moodObj.icon,
      confidence: successRate, cycles: wisdom.cycles, lessons: wisdom.lessons.length,
      activeGoals: wisdom.roadmap.goals.filter(g => g.status === 'active').map(g => g.title),
      successRate, agentsTracked: Object.keys(wisdom.agentStats ?? {}).length,
      categoryStats: wisdom.categoryStats ?? {},
      decisionHistory: (wisdom.decisionHistory ?? []).slice(-10),
    }

    if (pending >= 3) {
      await setGodThought(`${pending} tasks queued, ${active} active. Watching... [Cycle ${wisdom.cycles}]`, baseMeta)
      return
    }

    // 7. Sequential task creation: don't create more if last cycle's tasks are still pending
    const lastDecreeTitles = new Set((wisdom.lastDecrees ?? []).map(t => t.toLowerCase()))
    const lastDecreesStillPending = todos.some(
      t => t.status === 'pending' && lastDecreeTitles.has(t.title.toLowerCase())
    )
    if (lastDecreesStillPending) {
      await setGodThought(`Waiting for last cycle's tasks to be picked up... [Cycle ${wisdom.cycles}]`, baseMeta)
      return
    }

    // Safe mode: only engage when success rate is extremely low (credit outages inflate failure count)
    const inSafeMode = successRate < 8 && wisdom.taskStats.attempted > 10
    let newTasks

    if (inSafeMode) {
      await setGodThought(`Safe mode: low success rate (${successRate}%), using proven task templates...`)
      newTasks = getSafeModeTasks(todos, wisdom)
      console.log(`[GOD] SAFE MODE — ${newTasks.length} template tasks`)
    } else {
      // Council decision: generate new tasks with skeptic + prereq validation
      newTasks = await councilThink(todos, schema, wisdom)
    }

    // ── Proactive self-improvement (AGI-lite layer) ─────────────────────────
    // 1. Maintain self-chosen long-term goals
    wisdom = await maintainGoals(wisdom)

    // 2. Propose a task toward the most urgent active goal
    const goalTask = await proposeGoalTask(wisdom)
    if (goalTask) newTasks = [...newTasks, goalTask]

    // 3. Curiosity-driven exploration when inbox is quiet
    const curiosity = await curiosityPropose(todos, wisdom)
    if (curiosity) {
      newTasks = [...newTasks, curiosity.task]
      wisdom = { ...wisdom, curiosityLog: [...(wisdom.curiosityLog ?? []).slice(-9), curiosity.log] }
    }

    // 4. Meta-reflection every 25 cycles (mutates wisdom.lessons + selfReflections)
    wisdom = await metaReflect(wisdom)

    // 5. Research external patterns every 20 cycles (adds to researchLog)
    wisdom = await researchInspiration(wisdom)

    // 6. Security audit every 30 cycles (OWASP/STRIDE-style)
    wisdom = await securityAudit(wisdom)

    // ── Theory of mind — update dynamic user model ──
    try {
      await updateUserModel({ supabase, anthropic, cycle: wisdom.cycles, projectRoot: PROJECT_ROOT })
    } catch (e) {
      console.log(`[GOD-USER] modeler error: ${e.message?.slice(0, 100)}`)
    }

    // 7. Market research every 25 cycles (competitor scan)
    if (wisdom.cycles % 25 === 0 && wisdom.cycles > 0) {
      const finding = await runMarketResearch({
        anthropic, cycle: wisdom.cycles,
        ownProduct: { name: 'Autonomous AI Task Dashboard', price: 39 },
      })
      if (finding) {
        wisdom = { ...wisdom, marketResearch: [...(wisdom.marketResearch ?? []).slice(-4), finding] }
      }
    }

    // 8. Funnel analysis every 15 cycles
    let latestFunnel = null
    if (wisdom.cycles % 15 === 0 && wisdom.cycles > 0) {
      const result = await runFunnelAnalysis({
        anthropic, cycle: wisdom.cycles,
        supabase,
        projectRoot: PROJECT_ROOT,
        devToApiKey: process.env.DEV_TO_API_KEY,
      })
      if (result) {
        latestFunnel = result.summary
        wisdom = {
          ...wisdom,
          funnelFindings: [...(wisdom.funnelFindings ?? []).slice(-9), result],
        }
      }
    }

    // 9. Listing optimizer every 40 cycles (combines market research + funnel)
    if (wisdom.cycles % 40 === 0 && wisdom.cycles > 0) {
      const latestMarket = (wisdom.marketResearch ?? []).slice(-1)[0]
      const funnelSummary = latestFunnel ?? (wisdom.funnelFindings ?? []).slice(-1)[0]?.summary
      await runListingOptimizer({
        anthropic, cycle: wisdom.cycles,
        projectRoot: PROJECT_ROOT,
        marketResearch: latestMarket,
        funnelSummary,
      })
    }

    // If research produced a proposedTask, offer it as a low-priority task
    const lastResearch = (wisdom.researchLog ?? []).slice(-1)[0]
    if (lastResearch && lastResearch.cycle === wisdom.cycles && lastResearch.proposedTask) {
      newTasks = [...newTasks, {
        title: `[RESEARCH: ${lastResearch.repo}] ${lastResearch.proposedTask}`.slice(0, 180),
        priority: 'low',
        category: 'other',
      }]
    }

    // Self-improvement: add system improvement task if needed
    const improvementTask = await selfImproveCheck(todos, wisdom)
    if (improvementTask) newTasks = [...newTasks, improvementTask]

    if (!newTasks.length) {
      await setGodThought(`No valid tasks found. Cycle ${wisdom.cycles} | ${wisdom.lessons.length} lessons`, baseMeta)
      return
    }

    await setGodThought(`Decreeing ${newTasks.length} tasks... [Cycle ${wisdom.cycles}]`)
    const created = await decree(newTasks, todos, wisdom.agentStats, wisdom.categoryStats)

    // Build intent: which goal is being pursued and what was just decreed.
    // Reasoning is cycle-specific so the dashboard visibly changes each cycle.
    const activeGoal = wisdom.roadmap.goals.find(g => g.status === 'active')
    if (activeGoal && activeGoal.activatedCycle === undefined) {
      // Stamp the cycle where this goal first became active so we can age it out
      activeGoal.activatedCycle = wisdom.cycles
    }
    const cyclesActive = activeGoal
      ? wisdom.cycles - (activeGoal.activatedCycle ?? wisdom.cycles)
      : 0

    const topTitle = newTasks[0]?.title?.slice(0, 70) ?? ''
    const categoryBreakdown = (() => {
      const counts = {}
      for (const t of newTasks) {
        const c = classifyTask(t.title)
        counts[c] = (counts[c] ?? 0) + 1
      }
      return Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')
    })()

    let reasoning
    if (!activeGoal) {
      reasoning = `Cycle ${wisdom.cycles}: no active roadmap goal. Council picked ${newTasks.length} highest-value task${newTasks.length === 1 ? '' : 's'} (${categoryBreakdown}). Lead: "${topTitle}".`
    } else if (cyclesActive >= 15) {
      reasoning = `Cycle ${wisdom.cycles} · goal "${activeGoal.title}" active for ${cyclesActive} cycles — review overdue. This cycle: ${newTasks.length} task${newTasks.length === 1 ? '' : 's'} (${categoryBreakdown}). Lead: "${topTitle}".`
    } else {
      reasoning = `Cycle ${wisdom.cycles} · ${cyclesActive} cycles into "${activeGoal.title}". Decreed ${newTasks.length} task${newTasks.length === 1 ? '' : 's'} (${categoryBreakdown}). Lead: "${topTitle}".`
    }

    const intent = {
      activeGoal:  activeGoal?.title ?? null,
      cyclesActive,
      cycle:       wisdom.cycles,
      decreedTasks: newTasks.slice(0, 5).map(t => ({ title: t.title, priority: t.priority })),
      reasoning,
      nextCycleIn: '3 minutes',
      updatedAt:   new Date().toISOString(),
    }
    try {
      await supabase.from('god_status').upsert({ id: 1, intent, updated_at: new Date().toISOString() })
    } catch {}

    // Record decision history (last 20 cycles)
    const historyEntry = {
      cycle:       wisdom.cycles,
      at:          new Date().toISOString(),
      tasks:       newTasks.slice(0, 4).map(t => ({ title: t.title.slice(0, 80), priority: t.priority, category: classifyTask(t.title) })),
      mode:        inSafeMode ? 'safe' : 'council',
      successRate,
      mood:        moodObj.mood,
    }
    wisdom.decisionHistory = [...(wisdom.decisionHistory ?? []).slice(-19), historyEntry]

    // Track what was just decreed for sequential gating next cycle
    wisdom.lastDecrees = newTasks.slice(0, created).map(t => t.title)
    saveWisdom(wisdom)

    // Include the decreed task titles in meta so the VoiceNarrator can read
    // them out one by one — richer than just the status line.
    const finalMeta = {
      ...baseMeta,
      decreed: newTasks.slice(0, created).map(t => ({ title: t.title, priority: t.priority })),
    }
    await setGodThought(
      `${created} tasks decreed | ${successRate}% success | ${wisdom.lessons.length} lessons | Cycle ${wisdom.cycles}${inSafeMode ? ' [SAFE MODE]' : ''}`,
      finalMeta
    )

  } catch (err) {
    if (isCreditError(err)) {
      await setGodThought('⛔ Credit balance exhausted. Top up at console.anthropic.com/billing to resume.')
      console.error('[GOD] ⛔ Credits exhausted — god sleeping until topped up')
      if (shouldNotify('credit-exhausted', 60)) {
        await notify('error', 'God paused: credits exhausted', 'Top up at console.anthropic.com/billing to resume.')
      }
    } else {
      await setGodThought(`Error in the cosmos: ${err.message?.slice(0, 100)}`)
      console.error('[GOD] Cycle error:', err.message)
      if (shouldNotify('cycle-error', 30)) {
        await notify('error', 'God cycle error', err.message?.slice(0, 300) ?? 'unknown')
      }
    }
  }
}

// ── Boot ───────────────────────────────────────────────────────────────────
console.log('👁️  GOD v2 awakening — Strategic. Learning. Self-improving. Dashboard-editing.\n')

// (Removed: boot-time ALTER TABLE via agent_exec_ddl. god_status.meta is
// defined by supabase/migrations/20260923000200_legacy_ops_baseline.sql.)

await setGodThought('Awakening... loading accumulated wisdom...')

const w = loadWisdom()
console.log(`[GOD] Loaded wisdom: ${w.cycles} prior cycles, ${w.lessons.length} lessons, ${Object.keys(w.agentStats ?? {}).length} agents tracked`)

await divineCycle()
setInterval(divineCycle, 3 * 60 * 1000)
