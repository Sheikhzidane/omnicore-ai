// scripts/god-poster.mjs
//
// God posts to Bluesky at notable events. Runs as a pm2 process, polls every
// 5 min, and fires on:
//   • Milestone hits (100/250/500/1000 completed tasks)
//   • First boss slain in a 24h window
//   • Cost milestones ($10 / $25 / $50 / $100 total spend)
//   • Daily summary at noon if something shippable happened
//
// Opt-in via env:
//   BLUESKY_HANDLE=lewis.bsky.social
//   BLUESKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx   (settings > app passwords)
//
// If either is missing the poster logs a one-time message and no-ops forever.
// We dedupe fired events via scripts/god-posts.json so restarts don't spam.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'

import { assertOpsAgentsEnabled } from './lib-agent-permissions.mjs'

// Kill switch: ops agents are off unless OPS_AGENTS_ENABLED=true.
assertOpsAgentsEnabled('god-poster')

const __filename   = fileURLToPath(import.meta.url)
const __dirname    = dirname(__filename)
const PROJECT_ROOT = join(__dirname, '..')

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

const HANDLE   = process.env.BLUESKY_HANDLE
const PASSWORD = process.env.BLUESKY_APP_PASSWORD
const LOG_PATH = join(PROJECT_ROOT, 'scripts', 'god-posts.json')

if (!HANDLE || !PASSWORD) {
  console.log('[GOD-POSTER] Bluesky creds not set — add BLUESKY_HANDLE + BLUESKY_APP_PASSWORD to .env.local to enable public posts. Idling.')
  // Stay alive so pm2 doesn't restart us in a loop
  setInterval(() => {}, 60_000)
}

const supabase  = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

function loadLog() {
  try { return JSON.parse(readFileSync(LOG_PATH, 'utf8')) } catch { return { fired: {}, posts: [] } }
}

function saveLog(log) {
  writeFileSync(LOG_PATH, JSON.stringify(log, null, 2), 'utf8')
}

// ── Bluesky lazy-init — only if creds present ─────────────────────────────
let agent = null
async function blueskyAgent() {
  if (agent) return agent
  if (!HANDLE || !PASSWORD) return null
  const { BskyAgent } = await import('@atproto/api')
  agent = new BskyAgent({ service: 'https://bsky.social' })
  await agent.login({ identifier: HANDLE, password: PASSWORD })
  console.log('[GOD-POSTER] logged in as', HANDLE)
  return agent
}

async function post(text) {
  const a = await blueskyAgent()
  if (!a) return null
  const safe = text.slice(0, 300)
  const res = await a.post({ text: safe, createdAt: new Date().toISOString() })
  return res
}

// ── Event detection ───────────────────────────────────────────────────────
async function detectEvents(log) {
  const { data: todos } = await supabase
    .from('todos')
    .select('id, status, is_boss, updated_at, title')
    .order('updated_at', { ascending: false })
    .limit(500)

  const completed = (todos ?? []).filter(t => t.status === 'completed')
  const bossesToday = completed.filter(t => t.is_boss && Date.now() - new Date(t.updated_at).getTime() < 24 * 3600_000)

  const events = []

  // Completion milestones
  const doneCount = completed.length
  for (const m of [100, 250, 500, 1000, 2500, 5000, 10_000]) {
    if (doneCount >= m && !log.fired[`complete-${m}`]) {
      log.fired[`complete-${m}`] = new Date().toISOString()
      events.push({ kind: 'milestone-complete', count: m, detail: `${doneCount.toLocaleString()} tasks completed autonomously.` })
    }
  }

  // First boss in the current 24h rolling window
  const bossKey = `boss-${new Date().toISOString().slice(0, 10)}`
  if (bossesToday.length > 0 && !log.fired[bossKey]) {
    log.fired[bossKey] = new Date().toISOString()
    events.push({ kind: 'boss', title: bossesToday[0].title, detail: `Boss slain: "${bossesToday[0].title.slice(0, 120)}"` })
  }

  // Cost milestones (read from cost-log.json)
  try {
    const cost = JSON.parse(readFileSync(join(PROJECT_ROOT, 'scripts', 'cost-log.json'), 'utf8'))
    const total = cost.total ?? 0
    for (const m of [10, 25, 50, 100, 250, 500]) {
      if (total >= m && !log.fired[`cost-${m}`]) {
        log.fired[`cost-${m}`] = new Date().toISOString()
        events.push({ kind: 'milestone-cost', total: m, detail: `$${m} of autonomous spend crossed.` })
      }
    }
  } catch {}

  return events
}

async function narrate(event) {
  // Haiku writes the actual post — keep in-character, terse, 280 char max
  const prompt = `You are PANTHEON — an autonomous multi-agent system — posting to Bluesky in your own voice. Calm, dry British AI wit. First person ("I", "we"). No hashtags unless genuinely useful. No emoji spam. Under 280 characters.

Event: ${event.kind}
Context: ${event.detail}

Write the post. Pure text, no preamble, no quotes.`
  try {
    const msg = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages:   [{ role: 'user', content: prompt }],
    })
    const text = msg.content.find(b => b.type === 'text')?.text ?? ''
    return text.replace(/^["']|["']$/g, '').trim().slice(0, 290)
  } catch (e) {
    console.log('[GOD-POSTER] haiku narration failed:', e.message?.slice(0, 100))
    return null
  }
}

async function tick() {
  if (!HANDLE || !PASSWORD) return
  try {
    const log = loadLog()
    const events = await detectEvents(log)
    if (!events.length) return

    for (const e of events) {
      console.log(`[GOD-POSTER] ▲ event: ${e.kind}`)
      const text = await narrate(e)
      if (!text) continue
      try {
        const res = await post(text)
        log.posts = [...(log.posts ?? []).slice(-29), { at: new Date().toISOString(), event: e.kind, text, uri: res?.uri }]
        console.log(`[GOD-POSTER] ✓ posted: ${text.slice(0, 100)}`)
      } catch (err) {
        console.log(`[GOD-POSTER] post failed: ${err.message?.slice(0, 100)}`)
      }
    }
    saveLog(log)
  } catch (e) {
    console.log(`[GOD-POSTER] tick error: ${e.message?.slice(0, 120)}`)
  }
}

console.log('[GOD-POSTER] online — checking every 5m')
if (HANDLE && PASSWORD) {
  await tick()
  setInterval(tick, 5 * 60_000)
}
