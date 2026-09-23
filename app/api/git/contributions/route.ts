import type { NextRequest } from 'next/server'
import { requirePlatformAdminReadApi } from '@/lib/auth/api'
import { NextResponse } from 'next/server'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { IS_SERVERLESS } from '@/lib/runtime'

const execAsync = promisify(exec)
const REPO_ROOT = path.resolve(process.cwd())

// Returns a 365-day heatmap: { date: 'YYYY-MM-DD', commits: N, godCommits: N }
export async function GET(req: NextRequest) {
  const authz = await requirePlatformAdminReadApi(req)
  if (!authz.ok) return authz.response

  if (IS_SERVERLESS) {
    // Zero-filled 365 days with remote flag — component degrades gracefully
    const days = []
    const today = new Date()
    for (let i = 364; i >= 0; i--) {
      const d = new Date(today)
      d.setDate(d.getDate() - i)
      days.push({
        date:       d.toISOString().slice(0, 10),
        dayOfWeek:  d.getDay(),
        commits:    0,
        godCommits: 0,
      })
    }
    return NextResponse.json({
      days,
      totalCommits:    0,
      totalGodCommits: 0,
      maxCommits:      0,
      remote:          true,
      remoteNote:      'Contribution graph only renders from local dashboard (git access required).',
    })
  }

  try {
    const sinceDate = new Date()
    sinceDate.setDate(sinceDate.getDate() - 365)
    const since = sinceDate.toISOString().slice(0, 10)

    const { stdout } = await execAsync(
      `git log --since="${since}" --format="%aI|%s"`,
      { cwd: REPO_ROOT, timeout: 10_000 },
    )

    const buckets: Record<string, { commits: number; godCommits: number }> = {}

    for (const line of stdout.split('\n')) {
      if (!line || !line.includes('|')) continue
      const [iso, subject] = line.split('|')
      const day = iso.slice(0, 10)
      if (!buckets[day]) buckets[day] = { commits: 0, godCommits: 0 }
      buckets[day].commits++
      if (/\[god-(edit|agent)\]|^god/i.test(subject)) buckets[day].godCommits++
    }

    // Build a dense 365-day array
    const days = []
    const today = new Date()
    for (let i = 364; i >= 0; i--) {
      const d = new Date(today)
      d.setDate(d.getDate() - i)
      const key = d.toISOString().slice(0, 10)
      const b = buckets[key] ?? { commits: 0, godCommits: 0 }
      days.push({
        date:       key,
        dayOfWeek:  d.getDay(),
        commits:    b.commits,
        godCommits: b.godCommits,
      })
    }

    const totalCommits    = days.reduce((s, d) => s + d.commits, 0)
    const totalGodCommits = days.reduce((s, d) => s + d.godCommits, 0)
    const maxCommits      = Math.max(...days.map(d => d.commits))

    return NextResponse.json({
      days,
      totalCommits,
      totalGodCommits,
      maxCommits,
    })
  } catch (e) {
    const err = e as { message?: string }
    return NextResponse.json({ error: err.message ?? 'git log failed' }, { status: 500 })
  }
}
