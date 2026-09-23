// scripts/god-dreams.mjs
//
// Dream cycles — counterfactual replay during quiet hours. Between 02:00 and
// 05:00 local (override via DREAM_WINDOW=HH-HH) the system picks 3-5
// recent decisions from god_status.decisionHistory and asks a LOCAL Ollama
// model: "what if the council had chosen differently here?" Writes insights
// to scripts/agent-memory/dreams.json so they surface in next-day briefings.
//
// Uses Ollama exclusively — zero marginal cost. Runs as its own pm2 process.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

import { assertOpsAgentsEnabled } from './lib-agent-permissions.mjs'

// Kill switch: ops agents are off unless OPS_AGENTS_ENABLED=true.
assertOpsAgentsEnabled('god-dreams')

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

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

const OLLAMA_URL   = process.env.OLLAMA_URL || 'http://localhost:11434'
const OLLAMA_MODEL = process.env.OLLAMA_DREAM_MODEL || process.env.OLLAMA_FALLBACK_MODEL || 'llama3.2:3b'
const DREAM_DIR    = join(PROJECT_ROOT, 'scripts', 'agent-memory')
const DREAM_PATH   = join(DREAM_DIR, 'dreams.json')

// Window — default 02:00–05:00 local
const [DREAM_START_HOUR, DREAM_END_HOUR] = (process.env.DREAM_WINDOW ?? '2-5').split('-').map(Number)

function inDreamWindow() {
  const h = new Date().getHours()
  if (DREAM_START_HOUR <= DREAM_END_HOUR) return h >= DREAM_START_HOUR && h < DREAM_END_HOUR
  // wraps past midnight
  return h >= DREAM_START_HOUR || h < DREAM_END_HOUR
}

function loadDreams() {
  try { if (existsSync(DREAM_PATH)) return JSON.parse(readFileSync(DREAM_PATH, 'utf8')) } catch {}
  return { dreams: [], insights: [] }
}

function saveDreams(state) {
  if (!existsSync(DREAM_DIR)) mkdirSync(DREAM_DIR, { recursive: true })
  writeFileSync(DREAM_PATH, JSON.stringify(state, null, 2), 'utf8')
}

async function ollamaInfer(prompt) {
  const r = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model:  OLLAMA_MODEL,
      prompt,
      stream: false,
      options: { num_predict: 400, temperature: 0.8 },
    }),
    signal: AbortSignal.timeout(90_000),
  })
  if (!r.ok) throw new Error(`ollama HTTP ${r.status}`)
  const data = await r.json()
  return data.response ?? ''
}

async function ollamaAvailable() {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2500) })
    return r.ok
  } catch { return false }
}

async function runDream() {
  if (!(await ollamaAvailable())) {
    console.log('[DREAM] Ollama not reachable, skipping cycle')
    return
  }

  // Gather recent decisions + their outcomes
  const { data: row } = await supabase.from('god_status').select('meta, intent').eq('id', 1).single()
  const decisions = row?.meta?.decisionHistory ?? []
  if (decisions.length < 3) {
    console.log('[DREAM] not enough decision history yet')
    return
  }

  const sample = decisions.slice(-5)
  const cycleList = sample.map(d => d.cycle).join(', ')

  // Fetch how those cycles' tasks actually turned out
  const cutoff = new Date(Date.now() - 48 * 3600_000).toISOString()
  const { data: todos } = await supabase
    .from('todos')
    .select('title, status, updated_at')
    .gte('updated_at', cutoff)
    .order('updated_at', { ascending: false })
    .limit(80)

  const completed = (todos ?? []).filter(t => t.status === 'completed').slice(0, 10).map(t => t.title.slice(0, 60))
  const failed    = (todos ?? []).filter(t => t.status === 'failed').slice(0, 6).map(t => t.title.slice(0, 60))

  const prompt = `You are the dream-self of an autonomous AI agent system, running at night during idle hours. Your job is to replay recent decisions and surface one non-obvious insight.

Recent decision cycles (${cycleList}):
${sample.map(d => `  cycle ${d.cycle} [${d.mood}]: ${d.tasks?.map(t => t.title).join('; ') ?? '(no tasks)'}`).join('\n')}

Tasks that completed recently:
${completed.map(t => `  ✓ ${t}`).join('\n') || '  (none)'}

Tasks that failed recently:
${failed.map(t => `  ✕ ${t}`).join('\n') || '  (none)'}

Imagine the council had made different choices at one of these cycles. Pick ONE alternative path, walk through it briefly, and note what you think would have gone differently.

Output EXACTLY this JSON structure:
{
  "cycle_examined": <cycle number from above>,
  "alternative": "what the council could have chosen instead (1 sentence)",
  "counterfactual": "what would likely have changed (1-2 sentences)",
  "insight": "a lesson that applies going forward (1 sentence)"
}`

  try {
    const text = await ollamaInfer(prompt)
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) { console.log('[DREAM] no JSON in response'); return }
    const parsed = JSON.parse(match[0])

    const state = loadDreams()
    state.dreams = [
      ...(state.dreams ?? []).slice(-19),
      { at: new Date().toISOString(), model: OLLAMA_MODEL, ...parsed },
    ]
    if (parsed.insight && parsed.insight.length > 10) {
      state.insights = [...(state.insights ?? []).slice(-29), parsed.insight]
    }
    saveDreams(state)

    console.log(`[DREAM] 💭 dreamed about cycle ${parsed.cycle_examined}: ${String(parsed.insight ?? '').slice(0, 140)}`)
  } catch (e) {
    console.log(`[DREAM] failed: ${e.message?.slice(0, 120)}`)
  }
}

async function tick() {
  if (!inDreamWindow()) return
  await runDream()
}

console.log(`[DREAM] online — dreaming between ${DREAM_START_HOUR}:00 and ${DREAM_END_HOUR}:00 local`)

const arg = process.argv[2]
if (arg === 'run-now') {
  await runDream()
  process.exit(0)
}

await tick()
// Inside the dream window, run every 20 min; outside, check every 5 min
setInterval(tick, inDreamWindow() ? 20 * 60_000 : 5 * 60_000)
