import type { NextRequest } from 'next/server'
import { requirePlatformAdminReadApi } from '@/lib/auth/api'
import { NextResponse } from 'next/server'

interface WorkflowRun {
  id:           number
  name:         string
  head_branch:  string
  head_sha:     string
  status:       string
  conclusion:   string | null
  html_url:     string
  created_at:   string
  updated_at:   string
  run_number:   number
  event:        string
}

export async function GET(req: NextRequest) {
  const authz = await requirePlatformAdminReadApi(req)
  if (!authz.ok) return authz.response

  const repo  = process.env.GITHUB_REPO ?? ''
  const token = process.env.GITHUB_TOKEN ?? ''

  if (!repo) {
    return NextResponse.json({ configured: false, runs: [] })
  }

  const headers: Record<string, string> = {
    'Accept':     'application/vnd.github+json',
    'User-Agent': 'task-dashboard-god',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (token) headers['Authorization'] = `Bearer ${token}`

  try {
    const r = await fetch(
      `https://api.github.com/repos/${repo}/actions/runs?per_page=10`,
      { headers, cache: 'no-store', next: { revalidate: 0 } },
    )
    if (!r.ok) {
      return NextResponse.json({
        configured: true,
        error: `GitHub API ${r.status}`,
        runs: [],
      }, { status: 200 })
    }
    const data = await r.json() as { workflow_runs: WorkflowRun[] }
    return NextResponse.json({
      configured: true,
      repo,
      runs: (data.workflow_runs ?? []).map(w => ({
        id:         w.id,
        name:       w.name,
        branch:     w.head_branch,
        sha:        w.head_sha.slice(0, 7),
        status:     w.status,
        conclusion: w.conclusion,
        url:        w.html_url,
        at:         w.updated_at,
        runNumber:  w.run_number,
        event:      w.event,
      })),
    })
  } catch (e) {
    const err = e as { message?: string }
    return NextResponse.json({
      configured: true,
      error: err.message ?? 'fetch failed',
      runs: [],
    }, { status: 200 })
  }
}
