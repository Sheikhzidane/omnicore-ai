import type { NextRequest } from 'next/server'
import { requirePlatformAdminReadApi } from '@/lib/auth/api'
import { NextResponse } from 'next/server'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { measureAndLog } from '@/lib/response-logger'
import { logResponseStart, logResponseEnd } from '@/lib/response-timestamps'
import { logLatencyStart, logLatencyEnd } from '@/lib/latency-logger'

export const dynamic = 'force-dynamic'

interface CheckResult {
  name:    string
  status:  'ok' | 'degraded' | 'down' | 'disabled'
  latency?: number
  detail?: string
}

const TIMEOUT = 5000

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ])
}

async function check(name: string, fn: () => Promise<CheckResult>): Promise<CheckResult> {
  const start = Date.now()
  try {
    const r = await withTimeout(fn(), TIMEOUT)
    return { ...r, latency: Date.now() - start }
  } catch (e) {
    return { name, status: 'down', detail: (e as Error).message?.slice(0, 120), latency: Date.now() - start }
  }
}

async function checkSupabase(): Promise<CheckResult> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return { name: 'supabase', status: 'disabled', detail: 'env vars missing' }
  const sb = createClient(url, key)
  const { error } = await sb.from('todos').select('id', { head: true, count: 'exact' }).limit(1)
  return { name: 'supabase', status: error ? 'down' : 'ok', detail: error?.message }
}

async function checkAnthropic(): Promise<CheckResult> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return { name: 'anthropic', status: 'disabled', detail: 'no key' }
  // Cheap endpoint: list models (no tokens billed)
  const r = await fetch('https://api.anthropic.com/v1/models', {
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
  })
  if (r.ok) return { name: 'anthropic', status: 'ok' }
  const body = await r.text().catch(() => '')
  if (r.status === 401 || /credit/i.test(body)) return { name: 'anthropic', status: 'degraded', detail: 'credit/auth issue' }
  return { name: 'anthropic', status: 'down', detail: `HTTP ${r.status}` }
}

async function checkGitHub(): Promise<CheckResult> {
  const token = process.env.GITHUB_TOKEN
  if (!token) return { name: 'github', status: 'disabled', detail: 'no token' }
  const r = await fetch('https://api.github.com/rate_limit', {
    headers: { Authorization: `token ${token}`, 'User-Agent': 'pantheon-health' },
  })
  if (!r.ok) return { name: 'github', status: 'down', detail: `HTTP ${r.status}` }
  const body = await r.json() as { rate?: { remaining?: number; limit?: number } }
  const remaining = body.rate?.remaining ?? 0
  const limit     = body.rate?.limit     ?? 0
  const status = remaining < 100 ? 'degraded' : 'ok'
  return { name: 'github', status, detail: `${remaining}/${limit} remaining` }
}

async function checkEdgeTts(): Promise<CheckResult> {
  // /api/tts/edge responds without a key — if it's reachable locally we're fine
  try {
    const r = await fetch('http://localhost:3000/api/tts/edge', { method: 'GET' })
    if (r.ok) return { name: 'edge-tts', status: 'ok' }
    return { name: 'edge-tts', status: 'down', detail: `HTTP ${r.status}` }
  } catch (e) {
    return { name: 'edge-tts', status: 'down', detail: (e as Error).message?.slice(0, 80) }
  }
}

async function checkElevenLabs(): Promise<CheckResult> {
  const key = process.env.ELEVENLABS_API_KEY
  if (!key) return { name: 'elevenlabs', status: 'disabled', detail: 'no key' }
  const r = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
    headers: { 'xi-api-key': key },
  })
  if (!r.ok) return { name: 'elevenlabs', status: 'down', detail: `HTTP ${r.status}` }
  const body = await r.json() as { character_count?: number; character_limit?: number }
  const used    = body.character_count ?? 0
  const limit   = body.character_limit ?? 0
  const status = limit > 0 && used / limit > 0.95 ? 'degraded' : 'ok'
  return { name: 'elevenlabs', status, detail: `${used}/${limit} chars used` }
}

function checkPm2Logs(): CheckResult {
  // Peek at god's heartbeat via its pm2 output log mtime
  const logPath = join(process.env.USERPROFILE || process.env.HOME || '', '.pm2', 'logs', 'god-out.log')
  if (!existsSync(logPath)) return { name: 'god', status: 'disabled', detail: 'no pm2 log' }
  try {
    const ageMin = (Date.now() - statSync(logPath).mtime.getTime()) / 60_000
    if (ageMin > 10) return { name: 'god', status: 'degraded', detail: `no tick in ${Math.round(ageMin)}min` }
    return { name: 'god', status: 'ok', detail: `ticked ${Math.round(ageMin)}min ago` }
  } catch (e) {
    return { name: 'god', status: 'down', detail: (e as Error).message?.slice(0, 80) }
  }
}

function checkCostLog(): CheckResult {
  const path = join(process.cwd(), 'scripts', 'cost-log.json')
  if (!existsSync(path)) return { name: 'cost-log', status: 'disabled', detail: 'no log yet' }
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'))
    const sessions = Array.isArray(data.sessions) ? data.sessions : []
    const recent = sessions.filter((s: { at?: string }) => s.at && Date.now() - new Date(s.at).getTime() < 3600_000)
    return { name: 'cost-log', status: 'ok', detail: `${recent.length} calls in last hour` }
  } catch (e) {
    return { name: 'cost-log', status: 'down', detail: (e as Error).message?.slice(0, 80) }
  }
}

export async function GET(req: NextRequest) {
  const authz = await requirePlatformAdminReadApi(req)
  if (!authz.ok) return authz.response

  const startMs = logLatencyStart('/api/health', 'GET')

  const results = await Promise.all([
    check('supabase',   checkSupabase),
    check('anthropic',  checkAnthropic),
    check('github',     checkGitHub),
    check('edge-tts',   checkEdgeTts),
    check('elevenlabs', checkElevenLabs),
    Promise.resolve(checkPm2Logs()),
    Promise.resolve(checkCostLog()),
  ])

  const counts = { ok: 0, degraded: 0, down: 0, disabled: 0 }
  for (const r of results) counts[r.status]++

  const overall: 'ok' | 'degraded' | 'down' =
    counts.down > 0     ? 'down' :
    counts.degraded > 0 ? 'degraded' :
                          'ok'

  const elapsed = Date.now() - startMs
  const response = NextResponse.json({
    overall,
    checks: results,
    counts,
    totalLatency: elapsed,
    at: new Date().toISOString(),
  })

  // Log response generation end to latency.log (fire-and-forget)
  logLatencyEnd(startMs, '/api/health', 'GET')

  return response
}
