import { requirePlatformAdminApi } from '@/lib/auth/api'
import { NextRequest, NextResponse } from 'next/server'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { IS_SERVERLESS } from '@/lib/runtime'

const execAsync = promisify(exec)
const REPO_ROOT = path.resolve(process.cwd())

// POST /api/git/revert  — reverts a given commit SHA (creates a new revert commit)
export async function POST(req: NextRequest) {
  const authz = await requirePlatformAdminApi(req, 'ops.git.revert.post')
  if (!authz.ok) return authz.response

  if (IS_SERVERLESS) {
    return NextResponse.json({
      ok: false,
      error: 'Git revert only works from the local dashboard (http://localhost:3000). The hosted copy cannot write to the repo.',
    }, { status: 503 })
  }

  const body = await req.json().catch(() => null) as { sha?: string } | null
  const sha  = (body?.sha ?? '').trim()

  if (!/^[a-f0-9]{7,40}$/i.test(sha)) {
    return NextResponse.json({ error: 'invalid sha format' }, { status: 400 })
  }

  try {
    // Check if repo is dirty first — revert fails on a dirty tree
    const { stdout: dirtyOut } = await execAsync('git status --porcelain', { cwd: REPO_ROOT, timeout: 5_000 })
    if (dirtyOut.trim().length > 0) {
      return NextResponse.json({
        error: 'Working tree has uncommitted changes. Commit or stash first.',
        dirty: dirtyOut.trim().split('\n').slice(0, 8),
      }, { status: 409 })
    }

    const { stdout, stderr } = await execAsync(
      `git revert --no-edit ${sha}`,
      { cwd: REPO_ROOT, timeout: 10_000 },
    )

    const { stdout: newShaOut } = await execAsync('git rev-parse --short HEAD', { cwd: REPO_ROOT, timeout: 3_000 })

    return NextResponse.json({
      ok: true,
      reverted: sha,
      newSha: newShaOut.trim(),
      stdout,
      stderr,
    })
  } catch (e) {
    const err = e as { message?: string; stderr?: string; stdout?: string }
    return NextResponse.json({
      ok: false,
      error: err.message ?? 'revert failed',
      stderr: err.stderr ?? '',
      stdout: err.stdout ?? '',
    }, { status: 500 })
  }
}
