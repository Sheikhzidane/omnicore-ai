import type { NextRequest } from 'next/server'
import { requirePlatformAdminApi, requirePlatformAdminReadApi } from '@/lib/auth/api'
import { NextResponse } from 'next/server'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

export const dynamic = 'force-dynamic'

const DEFAULT_VOICE = process.env.EDGE_TTS_VOICE || 'en-GB-RyanNeural'
const MAX_CHARS     = 400
const WORKER_PATH   = join(process.cwd(), 'scripts', 'tts-edge-worker.mjs')

/**
 * Proxies Microsoft Edge's free neural TTS. The actual WebSocket call runs
 * in a child process (see scripts/tts-edge-worker.mjs) because Next.js's
 * webpack mangles the `ws` package's native bufferutil binding in the RSC
 * layer, breaking WebSocket masking. Spawning a plain Node process bypasses
 * webpack entirely.
 */
export async function POST(req: NextRequest) {
  const authz = await requirePlatformAdminApi(req, 'ops.tts.edge.post')
  if (!authz.ok) return authz.response

  let text: string
  try {
    const body = await req.json()
    text = String(body?.text ?? '').slice(0, MAX_CHARS).trim()
  } catch {
    return NextResponse.json({ error: 'bad-body' }, { status: 400 })
  }
  if (!text) return NextResponse.json({ error: 'empty-text' }, { status: 400 })

  try {
    const audio = await new Promise<Buffer>((resolve, reject) => {
      const child = spawn(process.execPath, [WORKER_PATH, DEFAULT_VOICE], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })

      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      const kill = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error('worker-timeout'))
      }, 15_000)

      child.stdout.on('data', (c: Buffer) => stdout.push(c))
      child.stderr.on('data', (c: Buffer) => stderr.push(c))
      child.on('error', (e) => { clearTimeout(kill); reject(e) })
      child.on('close', (code) => {
        clearTimeout(kill)
        if (code === 0) return resolve(Buffer.concat(stdout))
        const err = Buffer.concat(stderr).toString().slice(0, 200)
        reject(new Error(`worker-exit-${code}: ${err}`))
      })

      // Pipe the text in via stdin so we don't risk arg-length or quoting issues
      child.stdin.write(text)
      child.stdin.end()
    })

    if (!audio.length) throw new Error('empty-audio')

    return new Response(new Uint8Array(audio), {
      status: 200,
      headers: {
        'Content-Type':  'audio/mpeg',
        'Cache-Control': 'no-store',
        'X-TTS-Chars':   String(text.length),
        'X-TTS-Voice':   DEFAULT_VOICE,
      },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown'
    return NextResponse.json({ error: 'tts-failed', detail: msg.slice(0, 240) }, { status: 502 })
  }
}

export async function GET(req: NextRequest) {
  const authz = await requirePlatformAdminReadApi(req)
  if (!authz.ok) return authz.response

  return NextResponse.json({
    enabled: true,
    voice:   DEFAULT_VOICE,
    service: 'microsoft-edge-tts (child-process)',
  })
}
