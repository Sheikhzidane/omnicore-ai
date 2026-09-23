import type { NextRequest } from 'next/server'
import { requirePlatformAdminReadApi } from '@/lib/auth/api'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { NextResponse } from 'next/server'

const MEM_DIR = join(process.cwd(), 'scripts', 'agent-memory')

export const dynamic = 'force-dynamic'

interface Entry { agent: string; lesson: string; at: string; idx: number; bucket?: string }
interface TriagedBucket { text: string; at?: string | null }
interface TriagedMem {
  episodic?:   Array<TriagedBucket | string>
  semantic?:   Array<TriagedBucket | string>
  procedural?: Array<TriagedBucket | string>
  archived?:   Array<{ text: string; archived_at: string; reason: string }>
  lessons?:    string[]
  version?:    number
}

function lessonText(e: TriagedBucket | string): string {
  return typeof e === 'string' ? e : e.text
}

export async function GET(req: NextRequest) {
  const authz = await requirePlatformAdminReadApi(req)
  if (!authz.ok) return authz.response

  if (!existsSync(MEM_DIR)) return NextResponse.json({ entries: [], triaged: null })

  const files = readdirSync(MEM_DIR).filter(f => f.endsWith('.json'))
  const all: Entry[] = []
  let triaged: TriagedMem | null = null

  for (const f of files) {
    const path = join(MEM_DIR, f)
    let raw: TriagedMem
    try { raw = JSON.parse(readFileSync(path, 'utf8')) } catch { continue }

    // Capture the triaged buckets from global-lessons.json for the skill catalog.
    if (f === 'global-lessons.json' && raw.version === 2) {
      triaged = {
        episodic:   (raw.episodic   ?? []).slice(-40),
        semantic:   (raw.semantic   ?? []).slice(-40),
        procedural: (raw.procedural ?? []).slice(-40),
        archived:   (raw.archived   ?? []).slice(-20),
        version:    2,
      }
    }

    const lessons: string[] = Array.isArray(raw.lessons) ? raw.lessons : []
    if (!lessons.length) continue

    const mtime = statSync(path).mtime.toISOString()
    const agent = f.replace(/\.json$/, '')
    const tail = lessons.slice(-15)

    for (const [i, lesson] of tail.entries()) {
      all.push({
        agent,
        lesson,
        at:  new Date(new Date(mtime).getTime() - (tail.length - 1 - i) * 1000).toISOString(),
        idx: i,
      })
    }
  }

  all.sort((a, b) => b.at.localeCompare(a.at))
  return NextResponse.json({ entries: all.slice(0, 60), triaged })
}

// unused but kept in case we want to surface individual entries later
void lessonText
