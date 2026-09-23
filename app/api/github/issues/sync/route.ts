import type { NextRequest } from 'next/server'
import { requirePlatformAdminApi, requirePlatformAdminReadApi } from '@/lib/auth/api'
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

// POST /api/github/issues/sync — pull open GitHub issues into todos (status=proposed)
export async function POST(req: NextRequest) {
  const authz = await requirePlatformAdminApi(req, 'ops.github.issues.sync.post')
  if (!authz.ok) return authz.response

  const repo  = process.env.GITHUB_REPO ?? '' // e.g. "owner/repo"
  const token = process.env.GITHUB_TOKEN ?? ''

  if (!repo) {
    return NextResponse.json({
      error: 'GITHUB_REPO not set in .env.local (format: owner/repo)',
    }, { status: 400 })
  }

  const headers: Record<string, string> = {
    'Accept':     'application/vnd.github+json',
    'User-Agent': 'task-dashboard-god',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const r = await fetch(
    `https://api.github.com/repos/${repo}/issues?state=open&per_page=50`,
    { headers, cache: 'no-store' },
  )

  if (!r.ok) {
    const body = await r.text()
    return NextResponse.json({
      error: `GitHub API ${r.status}: ${body.slice(0, 200)}`,
    }, { status: r.status })
  }

  const issues = await r.json() as Array<{
    id:         number
    number:     number
    title:      string
    body:       string | null
    labels:     Array<{ name: string }>
    html_url:   string
    user:       { login: string }
    pull_request?: unknown
  }>

  // Filter out PRs (GitHub returns them as issues too)
  const real = issues.filter(i => !i.pull_request)

  const supabase = await createClient()

  // Load existing titles so we don't double-import
  const { data: existing } = await supabase
    .from('todos')
    .select('title')
    .in('status', ['proposed', 'pending', 'in_progress'])

  const existingTitles = new Set(
    ((existing ?? []) as Array<{ title: string }>).map(t => t.title.toLowerCase())
  )

  let imported = 0
  const errors: string[] = []

  for (const issue of real) {
    const title = `[GH #${issue.number}] ${issue.title}`
    if (existingTitles.has(title.toLowerCase())) continue

    const labels = issue.labels.map(l => l.name.toLowerCase())
    const priority =
      labels.some(l => ['critical', 'p0', 'urgent'].includes(l)) ? 'critical' :
      labels.some(l => ['high', 'p1', 'important'].includes(l))  ? 'high'     :
      labels.some(l => ['low', 'p3', 'wontfix'].includes(l))     ? 'low'      :
      'medium'

    const category =
      labels.some(l => ['db', 'database', 'sql'].includes(l))    ? 'db'       :
      labels.some(l => ['ui', 'design', 'frontend'].includes(l)) ? 'ui'       :
      labels.some(l => ['infra', 'devops', 'ci'].includes(l))    ? 'infra'    :
      'other'

    const { error } = await supabase.from('todos').insert({
      title,
      priority,
      status:         'proposed',
      assigned_agent: null,
      task_category:  category,
      comments:       [{
        agent: 'github',
        at:    new Date().toISOString(),
        text:  `From GitHub issue by @${issue.user.login}: ${issue.html_url}\n\n${(issue.body ?? '').slice(0, 500)}`,
      }],
    } as never)

    if (error) errors.push(`#${issue.number}: ${error.message}`)
    else imported++
  }

  return NextResponse.json({
    ok: true,
    repo,
    imported,
    skipped: real.length - imported - errors.length,
    total: real.length,
    errors,
  })
}

// GET — status check
export async function GET(req: NextRequest) {
  const authz = await requirePlatformAdminReadApi(req)
  if (!authz.ok) return authz.response

  const repo  = process.env.GITHUB_REPO ?? ''
  const token = process.env.GITHUB_TOKEN ?? ''
  return NextResponse.json({
    configured: Boolean(repo),
    hasToken:   Boolean(token),
    repo:       repo || null,
  })
}
