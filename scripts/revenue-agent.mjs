/**
 * revenue-agent.mjs — Autonomous Content Monetization Engine
 *
 * Generates technical articles about the autonomous agent system,
 * publishes them to dev.to, and tracks estimated earnings vs API costs.
 *
 * Revenue streams:
 *  1. dev.to Partner Program (pays per read, ~$0.50-$2 per 1000 reads)
 *  2. Medium Partner Program (if you cross-post: ~$2-5 per 1000 member reads)
 *  3. Gumroad product listings (agent generates product descriptions you can publish)
 *
 * Setup: add DEV_TO_API_KEY to .env.local
 *   Get your key: https://dev.to/settings/extensions → "DEV Community API Keys"
 *
 * pm2 start scripts/revenue-agent.mjs --name revenue
 */

import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { verifyUrl, verifyAndLog } from './lib-verify.mjs'

import { assertOpsAgentsEnabled } from './lib-agent-permissions.mjs'

// Kill switch: ops agents are off unless OPS_AGENTS_ENABLED=true.
assertOpsAgentsEnabled('revenue-agent')

const __dirname   = dirname(fileURLToPath(import.meta.url))
const ROOT        = join(__dirname, '..')

// ── Load env ──────────────────────────────────────────────────────────────────
const envPath = join(ROOT, '.env.local')
try {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/)
    if (m) process.env[m[1].trim()] = m[2].trim()
  }
} catch {}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const supabase  = createClient(
  process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const REVENUE_LOG  = join(__dirname, 'revenue-log.json')
const DRAFTS_PATH  = join(__dirname, 'article-drafts')
const MODELS       = { sonnet: 'claude-sonnet-4-6', haiku: 'claude-haiku-4-5-20251001' }
const INTERVAL_MS  = 24 * 60 * 60 * 1000 // 24 hours between posts (was 8h; throttled — see ADAPTIVE_BACKOFF below)
const VIEW_SYNC_MS = 30 * 60 * 1000      // sync dev.to view counts every 30 min — cheap, no LLM
const ADAPTIVE_BACKOFF = { lookback: 3, minViews: 30 }  // skip new posts if last N articles aggregated < minViews
const DEV_TO_KEY   = process.env.DEV_TO_API_KEY ?? ''

// Estimated earnings per 1000 views (conservative)
const EARN_PER_1K_VIEWS = 0.80  // USD

// ── Revenue log helpers ───────────────────────────────────────────────────────
function loadLog() {
  try {
    if (existsSync(REVENUE_LOG)) return JSON.parse(readFileSync(REVENUE_LOG, 'utf8'))
  } catch {}
  return {
    posts:                  [],
    totalEstimatedEarnings: 0,
    totalEstimatedViews:    0,
    gumroadProducts:        [],
    lastUpdated:            null,
  }
}

function saveLog(log) {
  log.lastUpdated = new Date().toISOString()
  writeFileSync(REVENUE_LOG, JSON.stringify(log, null, 2), 'utf8')
}

// ── Supabase helpers ──────────────────────────────────────────────────────────
async function getRecentCompletions() {
  const { data } = await supabase
    .from('todos')
    .select('title, status, task_category, created_at, completed_at')
    .eq('status', 'completed')
    .order('created_at', { ascending: false })
    .limit(20)
  return data ?? []
}

async function getSystemStats() {
  const { data: todos } = await supabase.from('todos').select('status, task_category')
  if (!todos) return {}
  const completed = todos.filter(t => t.status === 'completed').length
  const failed    = todos.filter(t => t.status === 'failed').length
  const total     = todos.length
  return { completed, failed, total, successRate: Math.round((completed / Math.max(total, 1)) * 100) }
}

// ── Article topic rotation ────────────────────────────────────────────────────
const TOPICS = [
  {
    type:  'weekly-recap',
    title: (n) => `What My AI Agents Shipped This Week (Issue #${n})`,
    tags:  ['ai', 'automation', 'productivity', 'programming'],
  },
  {
    type:  'technical-deep-dive',
    title: () => `Building a Self-Improving God Agent with Claude AI`,
    tags:  ['ai', 'claude', 'typescript', 'nextjs'],
  },
  {
    type:  'cost-transparency',
    title: () => `The Real Cost of Running Autonomous AI Agents (with live data)`,
    tags:  ['ai', 'productivity', 'automation', 'cloud'],
  },
  {
    type:  'architecture',
    title: () => `Multi-Agent Architecture: Specialist Routing in an Autonomous Task System`,
    tags:  ['ai', 'architecture', 'typescript', 'webdev'],
  },
  {
    type:  'lessons',
    title: (n) => `${n} Lessons from Running Autonomous AI Agents 24/7`,
    tags:  ['ai', 'devops', 'lessons', 'automation'],
  },
]

// ── Credit error detection ────────────────────────────────────────────────────
function isCreditError(err) {
  return err.status === 400 && (
    err.message?.includes('credit balance') ||
    err.message?.includes('credit balance is too low')
  )
}

// ── Article generation ────────────────────────────────────────────────────────
async function generateArticle(topic, completions, stats, postNumber) {
  const completionList = completions.slice(0, 10).map(t => `- ${t.title}`).join('\n') || '- No completions yet'

  const prompts = {
    'weekly-recap': `
Write a technical dev.to article (700-1000 words) as a weekly recap of an autonomous AI agent system.

Title: "${topic.title(postNumber)}"

System stats:
- Total tasks: ${stats.total ?? 0}
- Completed: ${stats.completed ?? 0} (${stats.successRate ?? 0}% success rate)
- Failed: ${stats.failed ?? 0}

Recent completions (real tasks my agents ran):
${completionList}

Write in first person, authentic developer voice. Include:
1. Short intro (what the system is — autonomous Claude AI agents running 24/7 on localhost, self-improving God orchestrator)
2. What shipped this week (use the real task titles above, humanise them)
3. 1-2 interesting technical challenges encountered
4. What's next on the roadmap
5. CTA: invite readers to follow for weekly updates

Be honest about failures too. Dev.to readers love authentic behind-the-scenes content.
Format in Markdown. Include a code snippet if relevant.`,

    'technical-deep-dive': `
Write a technical dev.to article (900-1200 words) about building an autonomous AI orchestration system.

Title: "${topic.title(postNumber)}"

Key details to cover:
- God Agent: autonomous orchestrator that runs every 2 minutes, self-improves
- Multi-agent pool: db-specialist, ui-specialist, ruflo-critical/high/medium
- Task routing: classifies tasks by category (db/ui/infra/analysis) → routes to specialist
- Wisdom system: persists lessons across restarts (god-wisdom.json)
- Council mode: for complex decisions, spins up multiple Claude instances
- Cost tracking: daily spend cap, per-task limits, credit exhaustion detection

Stack: Next.js 14, Supabase, Claude claude-sonnet-4-6, TypeScript, PM2, Tailwind

Write for intermediate/senior devs. Be specific. Include real code snippets (TypeScript/mjs).
Format in Markdown. The system is real and running — write authentically.`,

    'cost-transparency': `
Write a transparent, data-driven dev.to article (700-900 words) about the economics of running autonomous AI agents.

Title: "${topic.title(postNumber)}"

Real data:
- Daily API budget: $2.00
- System has spent ~$1.50 total across all sessions
- Using Claude claude-sonnet-4-6 (~$3/MTok in, $15/MTok out) and Haiku (~$0.25/MTok in)
- 80k input token cap per task, $0.10 per-task limit
- System auto-pauses when credits run low, auto-resumes

Cover:
1. What it costs to run AI agents continuously
2. How to track and cap costs in code (show the cost-tracking pattern)
3. The credit exhaustion problem and how to handle it gracefully
4. Cost optimisation: when to use Haiku vs Sonnet
5. Whether it's "worth it" (honest answer: depends on what they're building)

Format in Markdown. Include cost calculation examples.`,

    'architecture': `
Write a technical dev.to article (900-1100 words) about specialist agent routing in autonomous systems.

Title: "${topic.title(postNumber)}"

Architecture to explain:
- Task classification: keyword matching assigns db/ui/infra/analysis/other category
- Routing: db → db-specialist (Sonnet + SQL system prompt), ui → ui-specialist (Sonnet + React prompt)
- Fallback: analysis → ruflo-high, other → ruflo-medium (general Haiku agents)
- Shared memory: global-lessons.json updated by every agent, loaded by all
- Performance tracking: per-agent success rates, category-level statistics

Include:
- Why specialist routing matters (better results, cheaper - Haiku for simple tasks)
- The task classification function in TypeScript
- Agent pool configuration pattern
- Lessons from running this in production

Format in Markdown. Real code from a working system.`,

    'lessons': `
Write a listicle dev.to article (800-1000 words): "${topic.title(10)}"

Context: I've been running an autonomous multi-agent system 24/7. It creates its own tasks, routes them to specialist agents, self-improves via a God orchestrator. Here's what I've learned.

Lessons to cover (use real ones from the system):
1. Agents fail more than you expect — build retry + self-healing from day one
2. Cost runaway is real — always set hard token and dollar limits
3. Specialist routing > general routing — a db-focused prompt beats a generic one
4. Shared memory between agents compounds over time
5. The "God" pattern (meta-orchestrator) works better than fixed pipelines
6. Pre-flight validation catches ~30% of tasks that were doomed to fail
7. Context compression keeps agents focused (summarise after iteration 10)
8. Watch for stale tasks — agents crash, tasks get stuck; build cleanup
9. Your daily limit is your runway — treat it like a startup budget
10. The system will surprise you — let it experiment

Write authentically. Format in Markdown.`,
  }

  const prompt = prompts[topic.type] || prompts['weekly-recap']

  const msg = await anthropic.messages.create({
    model: MODELS.sonnet,
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  })

  return msg.content[0]?.type === 'text' ? msg.content[0].text : null
}

// ── dev.to publisher ──────────────────────────────────────────────────────────
async function postToDevTo(title, body, tags) {
  if (!DEV_TO_KEY) {
    console.log('[REVENUE] No DEV_TO_API_KEY set — skipping publish. Add it to .env.local')
    return null
  }

  try {
    const res = await fetch('https://dev.to/api/articles', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'api-key':       DEV_TO_KEY,
      },
      body: JSON.stringify({
        article: {
          title,
          body_markdown: body,
          published:     true,
          tags:          tags.slice(0, 4),
          series:        'Autonomous AI Agents',
        },
      }),
      signal: AbortSignal.timeout(15000),
    })

    if (!res.ok) {
      const err = await res.text()
      console.error(`[REVENUE] dev.to publish failed: ${res.status} ${err.slice(0, 200)}`)
      return null
    }

    const data = await res.json()
    console.log(`[REVENUE] ✅ Published: ${data.url}`)

    // Non-blocking verification: 15s later, fetch the URL and confirm the
    // article actually renders with the expected title. Catches the
    // "dev.to returned 201 but the article is a 404" silent failure case.
    setTimeout(() => {
      verifyAndLog(ROOT, 'devto-post',
        () => verifyUrl(data.url, { mustContain: [title.slice(0, 40)], minBytes: 2000 }),
        { kind: 'devto-post', url: data.url, id: data.id, title: title.slice(0, 80) },
      ).catch(() => {})
    }, 15_000)

    return { url: data.url, id: data.id, slug: data.slug }
  } catch (e) {
    console.error(`[REVENUE] dev.to error: ${e.message}`)
    return null
  }
}

// ── dev.to view sync ──────────────────────────────────────────────────────────
async function syncViewCounts(log) {
  if (!DEV_TO_KEY || log.posts.length === 0) return log

  let totalViews = 0
  for (const post of log.posts) {
    if (!post.devToId) continue
    try {
      const res = await fetch(`https://dev.to/api/articles/${post.devToId}`, {
        headers: { 'api-key': DEV_TO_KEY },
        signal:  AbortSignal.timeout(10000),
      })
      if (res.ok) {
        const data = await res.json()
        post.views          = data.page_views_count ?? post.views ?? 0
        post.reactions      = data.public_reactions_count ?? 0
        post.comments       = data.comments_count ?? 0
        post.estimatedEarns = (post.views / 1000) * EARN_PER_1K_VIEWS
      }
    } catch {}
    totalViews += post.views ?? 0
  }

  log.totalEstimatedViews    = totalViews
  log.totalEstimatedEarnings = log.posts.reduce((s, p) => s + (p.estimatedEarns ?? 0), 0)
  return log
}

// ── Gumroad product generator ─────────────────────────────────────────────────
async function generateGumroadProduct(completions, stats) {
  const prompt = `Write a compelling Gumroad product listing for a developer tool/template.

Product: "Autonomous AI Task Dashboard" — a Next.js + Supabase + Claude AI starter kit
that runs autonomous agents 24/7, self-improves, tracks costs, and manages tasks automatically.

System proof points:
- ${stats.total ?? 0} tasks processed, ${stats.successRate ?? 0}% success rate
- Self-improving God orchestrator with wisdom persistence
- Specialist agent routing (db/ui/infra)
- Real-time dashboard with Supabase Realtime
- Built-in cost tracking and daily spend caps

Write:
1. Product name (catchy)
2. Tagline (one sentence)
3. Description (200 words, for developers who want autonomous AI agents)
4. What's included (bullet list)
5. Suggested price: $29-$49

Format as JSON: { "name": "...", "tagline": "...", "description": "...", "included": [...], "price": 39 }`

  try {
    const msg = await anthropic.messages.create({
      model: MODELS.haiku,
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    })
    const text = msg.content[0]?.text ?? ''
    const match = text.match(/\{[\s\S]*\}/)
    if (match) return JSON.parse(match[0])
  } catch {}
  return null
}

// ── Pre-written draft loader ──────────────────────────────────────────────────
function loadNextDraft(postedTitles) {
  if (!existsSync(DRAFTS_PATH)) return null
  try {
    const files = readdirSync(DRAFTS_PATH)
      .filter(f => f.endsWith('.md'))
      .sort()

    for (const file of files) {
      const raw  = readFileSync(join(DRAFTS_PATH, file), 'utf8')
      // Parse frontmatter
      const fm   = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
      if (!fm) continue
      const meta = fm[1]
      const body = fm[2].trim()
      const titleMatch = meta.match(/title:\s*"(.+)"/)
      const tagsMatch  = meta.match(/tags:\s*\[([^\]]+)\]/)
      if (!titleMatch) continue
      const title = titleMatch[1]
      if (postedTitles.has(title)) continue  // already posted
      const tags = tagsMatch
        ? tagsMatch[1].split(',').map(t => t.trim().replace(/"/g, ''))
        : ['ai', 'automation']
      return { title, body, tags, file }
    }
  } catch (e) {
    console.error(`[REVENUE] Draft load error: ${e.message}`)
  }
  return null
}

// ── Main revenue cycle ────────────────────────────────────────────────────────
async function revenueCycle() {
  console.log('\n[REVENUE] ══ Revenue Cycle ══')
  const log = loadLog()

  // Sync view counts for existing posts
  const syncedLog = await syncViewCounts(log).catch(() => log)

  // Check cooldown — only post once per INTERVAL_MS
  const lastPost = syncedLog.posts.at(-1)
  if (lastPost) {
    const elapsed = Date.now() - new Date(lastPost.publishedAt).getTime()
    if (elapsed < INTERVAL_MS) {
      const nextIn = Math.round((INTERVAL_MS - elapsed) / 60000)
      console.log(`[REVENUE] Next post in ${nextIn} min. Views so far: ${syncedLog.totalEstimatedViews}, Est. earnings: $${syncedLog.totalEstimatedEarnings.toFixed(4)}`)
      saveLog(syncedLog)
      return
    }
  }

  // Adaptive back-off: if our last few posts collectively got fewer views
  // than we'd need to break even on the credits, stop generating until traffic
  // picks up. Saves us from burning $0.05+ per zero-view post.
  const recent = syncedLog.posts.slice(-ADAPTIVE_BACKOFF.lookback)
  if (recent.length >= ADAPTIVE_BACKOFF.lookback) {
    const totalRecentViews = recent.reduce((s, p) => s + (p.views ?? 0), 0)
    if (totalRecentViews < ADAPTIVE_BACKOFF.minViews) {
      console.log(`[REVENUE] ⏸ Skipping post — last ${ADAPTIVE_BACKOFF.lookback} posts got only ${totalRecentViews} views (need ${ADAPTIVE_BACKOFF.minViews}+). Distribution channel isn't working; throwing more content at it wastes credits.`)
      console.log('[REVENUE]    Will retry on next 24h tick. Manually share or improve SEO to break out.')
      saveLog(syncedLog)
      return
    }
  }

  // Get system data
  const [completions, stats] = await Promise.all([getRecentCompletions(), getSystemStats()])
  const postNumber = syncedLog.posts.length + 1

  // Pick topic (rotate through types)
  const topicIdx = (postNumber - 1) % TOPICS.length
  const topic    = TOPICS[topicIdx]

  console.log(`[REVENUE] Generating article #${postNumber}: "${topic.title(postNumber)}"`)

  // Try AI generation first, fall back to pre-written drafts if credits empty
  let body, title, tags
  try {
    body  = await generateArticle(topic, completions, stats, postNumber)
    title = topic.title(postNumber)
    tags  = topic.tags
  } catch (err) {
    if (isCreditError(err)) {
      console.log('[REVENUE] ⛔ Credits exhausted — checking pre-written drafts...')
      const postedTitles = new Set(syncedLog.posts.map(p => p.title))
      const draft = loadNextDraft(postedTitles)
      if (!draft) {
        console.log('[REVENUE] No drafts left — top up credits at console.anthropic.com/billing')
        return
      }
      body  = draft.body
      title = draft.title
      tags  = draft.tags
      console.log(`[REVENUE] Using pre-written draft: "${title}"`)
    } else {
      throw err
    }
  }
  if (!body) {
    console.error('[REVENUE] Article generation failed')
    return
  }

  // Publish to dev.to
  const published = await postToDevTo(title, body, tags)

  // Record in log
  const entry = {
    id:             postNumber,
    title,
    topicType:      topic.type,
    body:           body.slice(0, 500) + '...', // store preview only
    publishedAt:    new Date().toISOString(),
    platform:       'dev.to',
    devToId:        published?.id  ?? null,
    devToUrl:       published?.url ?? null,
    published:      !!published,
    views:          0,
    reactions:      0,
    estimatedEarns: 0,
    tags:           tags,
  }

  syncedLog.posts = [...syncedLog.posts, entry]

  // Generate Gumroad product on first run
  if (syncedLog.gumroadProducts.length === 0) {
    console.log('[REVENUE] Generating Gumroad product listing...')
    let product = null
    try { product = await generateGumroadProduct(completions, stats) } catch {}
    if (product) {
      syncedLog.gumroadProducts = [{ ...product, generatedAt: new Date().toISOString() }]
      console.log(`[REVENUE] Gumroad product: "${product.name}" — $${product.price}`)
      console.log('[REVENUE] → Post to: https://gumroad.com/products/new')
    }
  }

  saveLog(syncedLog)

  const action = published ? `published to ${published.url}` : 'saved (no API key)'
  console.log(`[REVENUE] Article #${postNumber} ${action}`)
  console.log(`[REVENUE] Total posts: ${syncedLog.posts.length} | Est. earnings: $${syncedLog.totalEstimatedEarnings.toFixed(4)}`)
}

// ── Boot ──────────────────────────────────────────────────────────────────────
console.log('[REVENUE] Autonomous content engine starting...')
if (!DEV_TO_KEY) {
  console.log('[REVENUE] ⚠️  DEV_TO_API_KEY not set — articles will be generated but NOT published')
  console.log('[REVENUE]    Get your key: https://dev.to/settings/extensions')
  console.log('[REVENUE]    Then add: DEV_TO_API_KEY=your_key to .env.local and restart')
}

// Helper: catches transient connection errors so the cycle doesn't die over a
// flaky network blip. Real errors still surface after `tries` attempts.
async function withRetry(fn, label, tries = 3, delayMs = 30_000) {
  for (let i = 0; i < tries; i++) {
    try { return await fn() } catch (e) {
      const transient = /connection|timeout|fetch|network|ECONN|ENOTFOUND|EAI_AGAIN/i.test(e.message ?? '')
      if (i === tries - 1 || !transient) throw e
      console.log(`[REVENUE] ${label} retry ${i + 1}/${tries} after transient error: ${e.message?.slice(0, 80)}`)
      await new Promise(r => setTimeout(r, delayMs * (i + 1)))
    }
  }
}

async function viewSyncTick() {
  try {
    const log = loadLog()
    const synced = await syncViewCounts(log)
    saveLog(synced)
    console.log(`[REVENUE-SYNC] ${synced.posts.length} posts · ${synced.totalEstimatedViews} views · $${(synced.totalEstimatedEarnings ?? 0).toFixed(4)}`)
  } catch (e) {
    console.error('[REVENUE-SYNC] error:', e.message)
  }
}

// Run immediately on start, then on independent timers.
viewSyncTick()
withRetry(() => revenueCycle(), 'cycle').catch(e => console.error('[REVENUE] Cycle error:', e.message))

setInterval(viewSyncTick, VIEW_SYNC_MS)
setInterval(() => {
  withRetry(() => revenueCycle(), 'cycle').catch(e => console.error('[REVENUE] Cycle error:', e.message))
}, INTERVAL_MS)
