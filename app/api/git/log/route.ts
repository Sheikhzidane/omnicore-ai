import { requirePlatformAdminReadApi } from '@/lib/auth/api'
import { NextRequest, NextResponse } from 'next/server'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { IS_SERVERLESS } from '@/lib/runtime'

const execAsync = promisify(exec)
const REPO_ROOT = path.resolve(process.cwd())

interface Commit {
  sha:       string
  shortSha:  string
  subject:   string
  author:    string
  date:      string
  filesChanged: number
  branch:    string
  isGod:     boolean
}

export async function GET(req: NextRequest) {
  const authz = await requirePlatformAdminReadApi(req)
  if (!authz.ok) return authz.response

  if (IS_SERVERLESS) {
    return NextResponse.json({
      commits: [],
      currentBranch: 'main',
      total: 0,
      remote: true,
      remoteNote: 'Git history is only available when the dashboard runs on your local PC (http://localhost:3000). This hosted copy can\'t read the repo.',
    })
  }

  const n = Math.min(100, Math.max(5, Number(req.nextUrl.searchParams.get('n') ?? 30)))

  try {
    const fmt = '%H|%h|%s|%an|%aI'
    const { stdout } = await execAsync(
      `git log -n ${n} --format="${fmt}" --shortstat`,
      { cwd: REPO_ROOT, timeout: 8_000 },
    )

    const commits: Commit[] = []
    const lines = stdout.split('\n').filter(Boolean)

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line.includes('|')) continue
      const [sha, shortSha, subject, author, date] = line.split('|')
      // Next line (if exists) is the shortstat: " 2 files changed, 10 insertions(+), 3 deletions(-)"
      const statLine = lines[i + 1]
      let filesChanged = 0
      if (statLine && /file.+changed/.test(statLine)) {
        const m = statLine.match(/(\d+) files? changed/)
        if (m) filesChanged = Number(m[1])
        i++
      }
      commits.push({
        sha, shortSha, subject, author, date,
        filesChanged,
        branch: '',
        isGod:  /\[god-(edit|agent)\]|^god/i.test(subject) || /god/i.test(author),
      })
    }

    // Get current branch
    const { stdout: br } = await execAsync('git rev-parse --abbrev-ref HEAD', {
      cwd: REPO_ROOT, timeout: 3_000,
    })
    const currentBranch = br.trim()

    return NextResponse.json({
      commits,
      currentBranch,
      total: commits.length,
    })
  } catch (e) {
    const err = e as { message?: string }
    return NextResponse.json({ error: err.message ?? 'git log failed' }, { status: 500 })
  }
}
