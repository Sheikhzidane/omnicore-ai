import type { NextRequest } from 'next/server'
import { requirePlatformAdminReadApi } from '@/lib/auth/api'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { NextResponse } from 'next/server'

const COST_LOG_PATH = join(process.cwd(), 'scripts', 'cost-log.json')
const GOD_ERR_LOG   = join(process.env.USERPROFILE || process.env.HOME || '', '.pm2', 'logs', 'god-error.log')

export const dynamic = 'force-dynamic'

interface Session { at: string; agent: string; cost: number; inputTokens: number; outputTokens: number }

function readCostLog() {
  try {
    if (!existsSync(COST_LOG_PATH)) return { total: 0, byAgent: {}, sessions: [] as Session[] }
    return JSON.parse(readFileSync(COST_LOG_PATH, 'utf8'))
  } catch {
    return { total: 0, byAgent: {}, sessions: [] as Session[] }
  }
}

/** Sum cost of sessions whose timestamp is within the last `minutes` minutes. */
function costWithin(sessions: Session[], minutes: number) {
  const cutoff = Date.now() - minutes * 60_000
  return sessions
    .filter(s => s.at && new Date(s.at).getTime() >= cutoff)
    .reduce((sum, s) => sum + (s.cost ?? 0), 0)
}

function costSince(sessions: Session[], iso: string) {
  if (!iso) return 0
  const cutoff = new Date(iso).getTime()
  if (!Number.isFinite(cutoff)) return 0
  return sessions
    .filter(s => s.at && new Date(s.at).getTime() >= cutoff)
    .reduce((sum, s) => sum + (s.cost ?? 0), 0)
}

/** Cheap tail of the pm2 error log, but only if the file itself was touched
 *  in the last 10 minutes. pm2 doesn't timestamp each line, so we use the
 *  file's mtime as our "recency" floor — old "CREDIT EXHAUSTED" lines sitting
 *  in an unmodified log don't count. */
function recentCreditExhaustion(): boolean {
  try {
    if (!existsSync(GOD_ERR_LOG)) return false
    const stat = statSync(GOD_ERR_LOG)
    const ageMin = (Date.now() - stat.mtime.getTime()) / 60_000
    if (ageMin > 10) return false // no recent writes → nothing's current

    const raw  = readFileSync(GOD_ERR_LOG, 'utf8')
    const tail = raw.slice(-12_000).split('\n').slice(-80)
    return tail.some(l => /credit/i.test(l))
  } catch {
    return false
  }
}

export async function GET(req: NextRequest) {
  const authz = await requirePlatformAdminReadApi(req)
  if (!authz.ok) return authz.response

  const data = readCostLog()
  const sessions: Session[] = data.sessions ?? []

  const dailyLimit = Number(process.env.DAILY_COST_LIMIT_USD ?? 2)
  const topupUsd   = Number(process.env.ANTHROPIC_CREDITS_USD ?? 0)
  const topupAt    = process.env.ANTHROPIC_CREDITS_AT ?? ''

  // Burn rate: averaged over the last 3 hours (higher signal than 24h for a
  // system that bursts), clamped to a tiny floor so ETAs don't divide by zero.
  const cost3h        = costWithin(sessions, 180)
  const burnPerHour   = Math.max(cost3h / 3, 0.0001)
  const todaySpend    = sessions
    .filter(s => s.at?.startsWith(new Date().toISOString().slice(0, 10)))
    .reduce((sum, s) => sum + (s.cost ?? 0), 0)

  const spentSinceTopup   = costSince(sessions, topupAt)
  const estimatedBalance  = topupUsd > 0 ? Math.max(topupUsd - spentSinceTopup, 0) : null
  const exhausted         = recentCreditExhaustion()

  const hoursUntilDailyCap = burnPerHour > 0.001 ? (dailyLimit - todaySpend) / burnPerHour : null
  const hoursUntilZero     = estimatedBalance !== null && burnPerHour > 0.001 ? estimatedBalance / burnPerHour : null

  const creditStatus: 'exhausted' | 'low' | 'ok' | 'unknown' =
    exhausted                                                                         ? 'exhausted' :
    estimatedBalance !== null && estimatedBalance < 2                                 ? 'low' :
    estimatedBalance !== null                                                         ? 'ok' :
                                                                                        'unknown'

  return NextResponse.json({
    ...data,
    dailyLimit,
    todaySpend,
    burnPerHour,
    cost3h,
    estimatedBalance,
    topupAt,
    creditStatus,
    hoursUntilDailyCap,
    hoursUntilZero,
  })
}
