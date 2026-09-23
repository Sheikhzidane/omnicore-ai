// scripts/jarvis-briefings.mjs
//
// Single pm2 process that handles BOTH the daily briefing and the weekly
// podcast. Checks the clock every minute and fires the right generator at
// the right time. Script-gates itself via last-fired timestamps so a pm2
// restart doesn't re-play yesterday's briefing.
//
// Each run:
//   1. Pull todos + costs + god state
//   2. Have Haiku write a short scripted narration (cheap)
//   3. Spawn the existing Edge TTS worker → get MP3 bytes
//   4. Write to public/briefings/YYYY-MM-DD.mp3 + update a manifest
//   5. Dashboard serves the latest via /api/briefings
//
// Daily fires at 07:05 local. Weekly fires on Sunday at 18:00 local.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'

import { assertOpsAgentsEnabled } from './lib-agent-permissions.mjs'

// Kill switch: ops agents are off unless OPS_AGENTS_ENABLED=true.
assertOpsAgentsEnabled('jarvis-briefings')

const __filename   = fileURLToPath(import.meta.url)
const __dirname    = dirname(__filename)
const PROJECT_ROOT = join(__dirname, '..')

// Load .env.local
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

const supabase  = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const BRIEFING_DIR  = join(PROJECT_ROOT, 'public', 'briefings')
const MANIFEST_PATH = join(BRIEFING_DIR, 'manifest.json')
const WORKER_PATH   = join(PROJECT_ROOT, 'scripts', 'tts-edge-worker.mjs')

if (!existsSync(BRIEFING_DIR)) mkdirSync(BRIEFING_DIR, { recursive: true })

function loadManifest() {
  try { return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) } catch { return { daily: [], weekly: [] } }
}

function saveManifest(m) {
  writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2), 'utf8')
}

async function getData() {
  const [{ data: todos }, cost] = await Promise.all([
    supabase.from('todos').select('*').order('updated_at', { ascending: false }).limit(200),
    fetchCost(),
  ])
  return { todos: todos ?? [], cost }
}

function fetchCost() {
  const path = join(PROJECT_ROOT, 'scripts', 'cost-log.json')
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return { total: 0, sessions: [] } }
}

function summarizeWindow(todos, hours) {
  const cutoff = Date.now() - hours * 3600_000
  const recent = todos.filter(t => new Date(t.updated_at ?? t.created_at ?? 0).getTime() >= cutoff)
  return {
    total:     recent.length,
    completed: recent.filter(t => t.status === 'completed').length,
    failed:    recent.filter(t => t.status === 'failed').length,
    vetoed:    recent.filter(t => t.status === 'vetoed').length,
    bosses:    recent.filter(t => t.status === 'completed' && t.is_boss).length,
    topTitles: recent.filter(t => t.status === 'completed').slice(0, 5).map(t => t.title),
  }
}

async function writeScript(kind, ctx) {
  const prompt = kind === 'daily'
    ? `You are Jarvis giving a 60-second morning briefing to Lewis, the operator of an autonomous agent system.
Data from the last 12 hours:
${JSON.stringify(ctx, null, 2)}

Write a spoken narration (plain text, no stage directions, no markdown) ≤90 words. Start with "Good morning, sir.". Be concise, specific, mildly witty. Reference one or two real numbers. End with a recommendation.`
    : `You are Jarvis recording a 2-minute weekly podcast episode for Lewis, the operator of an autonomous agent system.
Data from the last 7 days:
${JSON.stringify(ctx, null, 2)}

Write a spoken narration (plain text, no stage directions) ≤320 words. Structure: greeting → highlights of the week → worst moment → best moment → outlook. Dry British wit. End with "Until next Sunday, sir."`

  const msg = await anthropic.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: kind === 'daily' ? 250 : 700,
    messages:   [{ role: 'user', content: prompt }],
  })
  const text = msg.content.find(b => b.type === 'text')?.text ?? ''
  return text.replace(/\*\*|\*/g, '').trim()
}

async function synthesize(text) {
  // Edge TTS worker emits MP3 to stdout
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER_PATH, 'en-GB-RyanNeural'], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    })
    const out = [], err = []
    const kill = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('tts-timeout')) }, 60_000)
    child.stdout.on('data', c => out.push(c))
    child.stderr.on('data', c => err.push(c))
    child.on('close', code => {
      clearTimeout(kill)
      if (code === 0) resolve(Buffer.concat(out))
      else reject(new Error('tts-exit-' + code + ': ' + Buffer.concat(err).toString().slice(0, 200)))
    })
    child.stdin.write(text.slice(0, 8000))
    child.stdin.end()
  })
}

async function runBriefing(kind) {
  const now = new Date()
  const dateStr = now.toISOString().slice(0, 10)
  const fileName = kind === 'daily' ? `${dateStr}-daily.mp3` : `${dateStr}-weekly.mp3`
  const outPath  = join(BRIEFING_DIR, fileName)
  const manifest = loadManifest()

  if ((manifest[kind] ?? []).some(e => e.file === fileName)) {
    console.log(`[JARVIS-${kind.toUpperCase()}] already generated today, skipping`)
    return
  }

  console.log(`[JARVIS-${kind.toUpperCase()}] generating briefing for ${dateStr}`)
  try {
    const { todos, cost } = await getData()
    const hours = kind === 'daily' ? 12 : 24 * 7
    const summary = summarizeWindow(todos, hours)
    const todayCost = cost.sessions?.filter(s => s.at?.startsWith(dateStr)).reduce((a, b) => a + (b.cost ?? 0), 0) ?? 0

    const ctx = { window: `${hours}h`, ...summary, costInWindow: todayCost.toFixed(3), totalAllTime: cost.total?.toFixed(2) ?? '0' }
    const script = await writeScript(kind, ctx)
    console.log(`[JARVIS-${kind.toUpperCase()}] script (${script.length} chars): ${script.slice(0, 140)}...`)

    const mp3 = await synthesize(script)
    writeFileSync(outPath, mp3)

    manifest[kind] = [...(manifest[kind] ?? []).slice(-29), {
      at: now.toISOString(), date: dateStr, file: fileName, script: script.slice(0, 2000), bytes: mp3.length,
    }]
    saveManifest(manifest)
    console.log(`[JARVIS-${kind.toUpperCase()}] ✓ saved ${fileName} (${mp3.length} bytes)`)
  } catch (e) {
    console.log(`[JARVIS-${kind.toUpperCase()}] failed: ${e.message?.slice(0, 200)}`)
  }
}

// Tick every minute; fire at the right time
function shouldFireDaily(d) {
  return d.getHours() === 7 && d.getMinutes() === 5
}
function shouldFireWeekly(d) {
  return d.getDay() === 0 /* Sunday */ && d.getHours() === 18 && d.getMinutes() === 0
}

console.log('[JARVIS-BRIEFINGS] online — daily 07:05, weekly Sun 18:00')

async function tick() {
  const now = new Date()
  if (shouldFireDaily(now))  await runBriefing('daily')
  if (shouldFireWeekly(now)) await runBriefing('weekly')
}

// Optional: manual trigger via command-line argument
const arg = process.argv[2]
if (arg === 'daily' || arg === 'weekly') {
  await runBriefing(arg)
  process.exit(0)
}

await tick()
setInterval(tick, 60_000)
