import { requirePlatformAdminReadApi } from '@/lib/auth/api'
import { NextRequest, NextResponse } from 'next/server'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const PM2_LOG_DIR = path.join(os.homedir(), '.pm2', 'logs')

const STREAMS = [
  { name: 'god',                 file: 'god-out.log' },
  { name: 'ruflo-agents',        file: 'ruflo-agents-out.log' },
  { name: 'ruflo-orchestrator',  file: 'ruflo-orchestrator-out.log' },
  { name: 'revenue',             file: 'revenue-out.log' },
  { name: 'god-err',             file: 'god-error.log' },
  { name: 'ruflo-agents-err',    file: 'ruflo-agents-error.log' },
  { name: 'revenue-err',         file: 'revenue-error.log' },
]

async function tailLines(filePath: string, lines: number): Promise<string[]> {
  try {
    const stat = await fs.stat(filePath)
    const chunk = Math.min(stat.size, Math.max(lines * 200, 16_384))
    if (chunk === 0) return []
    const fd = await fs.open(filePath, 'r')
    try {
      const buf = Buffer.alloc(chunk)
      await fd.read(buf, 0, chunk, stat.size - chunk)
      return buf.toString('utf8').split('\n').filter(Boolean).slice(-lines)
    } finally {
      await fd.close()
    }
  } catch {
    return []
  }
}

interface Event {
  ts:       number
  source:   string
  level:    'info' | 'warn' | 'error'
  category: string
  text:     string
}

function classify(source: string, text: string): { category: string; level: Event['level'] } {
  const isErr = source.endsWith('-err')
  const s = text.toLowerCase()
  let category = 'info'
  if (/\[god-edit\]|god is directly improving/i.test(text)) category = 'edit'
  else if (/\[god-agent-edit\]|god is improving the agent/i.test(text)) category = 'agent-edit'
  else if (/\[god-web\]|searching the internet/i.test(text)) category = 'web'
  else if (/\[god-postmortem\]|regression detected|lessons/i.test(text)) category = 'learn'
  else if (/decreed|proposed|cycle/i.test(text)) category = 'decree'
  else if (/cost cap|credit|rate_limit|429|daily limit/i.test(text)) category = 'cost'
  else if (/published|gumroad|dev\.to/i.test(text)) category = 'revenue'
  else if (/\[.+-specialist/i.test(text)) category = 'specialist'

  const level: Event['level'] =
    isErr || s.includes('error') || s.includes('❌') || s.includes('⛔') ? 'error' :
    s.includes('warn') || s.includes('⚠') ? 'warn' : 'info'
  return { category, level }
}

export async function GET(req: NextRequest) {
  const authz = await requirePlatformAdminReadApi(req)
  if (!authz.ok) return authz.response

  const n = Math.min(500, Math.max(20, Number(req.nextUrl.searchParams.get('n') ?? 200)))
  const events: Event[] = []

  const results = await Promise.all(STREAMS.map(async stream => {
    const lines = await tailLines(path.join(PM2_LOG_DIR, stream.file), n)
    const baseSource = stream.name.replace(/-err$/, '')
    return lines.map<Event>(line => {
      const clean = line.replace(/^\d+\|[a-z0-9-]+\s*\|\s*/i, '').trim()
      const { category, level } = classify(stream.name, clean)
      return {
        ts:       Date.now(),
        source:   baseSource,
        level,
        category,
        text:     clean,
      }
    })
  }))

  for (const arr of results) events.push(...arr)

  events.sort((a, b) => a.text.localeCompare(b.text))
  return NextResponse.json({ events: events.slice(-n) })
}
