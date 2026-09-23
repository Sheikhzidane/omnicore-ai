import { requirePlatformAdminApi, requirePlatformAdminReadApi } from '@/lib/auth/api'
import { NextRequest, NextResponse } from 'next/server'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { IS_SERVERLESS } from '@/lib/runtime'

const execAsync = promisify(exec)

const ALLOWED_NAMES = new Set(['god', 'ruflo-agents', 'ruflo-orchestrator', 'revenue', 'promote', 'all'])
const ALLOWED_ACTIONS = new Set(['start', 'stop', 'restart', 'reload'])

function serverlessPayload() {
  return {
    agents:     [],
    remote:     true,
    remoteNote: 'This dashboard is running on Vercel — the agents run on your local PC. Agent controls only work when the dashboard is open at http://localhost:3000.',
  }
}

export async function POST(req: NextRequest) {
  const authz = await requirePlatformAdminApi(req, 'ops.agents.control.post')
  if (!authz.ok) return authz.response

  if (IS_SERVERLESS) {
    return NextResponse.json({
      ok:    false,
      error: 'Agent controls run on your local PC only. Open http://localhost:3000 and try again.',
    }, { status: 503 })
  }

  const body = await req.json().catch(() => null) as { action?: string; name?: string } | null
  const action = (body?.action ?? '').toLowerCase()
  const name   = (body?.name   ?? '').toLowerCase()

  if (!ALLOWED_ACTIONS.has(action)) {
    return NextResponse.json({ error: `action must be one of: ${Array.from(ALLOWED_ACTIONS).join(', ')}` }, { status: 400 })
  }
  if (!ALLOWED_NAMES.has(name)) {
    return NextResponse.json({ error: `name must be one of: ${Array.from(ALLOWED_NAMES).join(', ')}` }, { status: 400 })
  }

  try {
    const cmd = `pm2 ${action} ${name} --update-env`
    const { stdout, stderr } = await execAsync(cmd, { timeout: 15_000 })
    return NextResponse.json({ ok: true, action, name, stdout, stderr })
  } catch (e) {
    const err = e as { message?: string; stderr?: string; stdout?: string }
    return NextResponse.json({
      ok: false,
      error: err.message ?? 'pm2 command failed',
      stderr: err.stderr ?? '',
      stdout: err.stdout ?? '',
    }, { status: 500 })
  }
}

// GET /api/agents/control — returns current pm2 status
export async function GET(req: NextRequest) {
  const authz = await requirePlatformAdminReadApi(req)
  if (!authz.ok) return authz.response

  if (IS_SERVERLESS) {
    // Return 200 with an empty list so the UI renders cleanly (just shows
    // "agents: n/a" in the sticky header) instead of throwing a red banner.
    return NextResponse.json(serverlessPayload())
  }

  try {
    const { stdout } = await execAsync('pm2 jlist', { timeout: 10_000 })
    const procs = JSON.parse(stdout || '[]') as Array<{
      name: string
      pm2_env: { status: string; restart_time: number; pm_uptime: number }
      monit: { cpu: number; memory: number }
    }>
    return NextResponse.json({
      agents: procs
        .filter(p => ALLOWED_NAMES.has(p.name))
        .map(p => ({
          name:        p.name,
          status:      p.pm2_env.status,
          restarts:    p.pm2_env.restart_time,
          uptimeStart: p.pm2_env.pm_uptime,
          cpu:         p.monit?.cpu    ?? 0,
          memoryMb:    Math.round((p.monit?.memory ?? 0) / 1024 / 1024),
        })),
    })
  } catch (e) {
    const err = e as { message?: string; stderr?: string }
    // Fallback: if pm2 is installed but not running yet, return empty list
    // so the UI doesn't show a red banner.
    const msg = err.message ?? err.stderr ?? 'pm2 not available'
    if (/command not found|No such file/.test(msg)) {
      return NextResponse.json({
        agents:     [],
        remote:     true,
        remoteNote: 'pm2 not installed on this runtime. Install pm2 locally or run the dashboard from your PC.',
      })
    }
    return NextResponse.json({ error: msg, agents: [] }, { status: 200 })
  }
}
