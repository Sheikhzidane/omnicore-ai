import { requirePlatformAdminApi, requirePlatformAdminReadApi } from '@/lib/auth/api'
import { NextResponse, NextRequest } from 'next/server'

export async function GET(req: NextRequest) {
  const authz = await requirePlatformAdminReadApi(req)
  if (!authz.ok) return authz.response

  return NextResponse.json({
    discord:  Boolean(process.env.DISCORD_WEBHOOK_URL),
    slack:    Boolean(process.env.SLACK_WEBHOOK_URL),
    pushover: Boolean(process.env.PUSHOVER_USER && process.env.PUSHOVER_TOKEN),
    telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
    any:
      Boolean(process.env.DISCORD_WEBHOOK_URL) ||
      Boolean(process.env.SLACK_WEBHOOK_URL) ||
      Boolean(process.env.PUSHOVER_USER && process.env.PUSHOVER_TOKEN) ||
      Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
  })
}

// POST /api/notify/status — send a test notification
export async function POST(req: NextRequest) {
  const authz = await requirePlatformAdminApi(req, 'ops.notify.status.post')
  if (!authz.ok) return authz.response

  const body = await req.json().catch(() => ({})) as { title?: string; message?: string }
  const title = body.title ?? 'Test notification'
  const message = body.message ?? `Fired at ${new Date().toISOString()} from the dashboard`

  const tasks: Promise<unknown>[] = []
  const errors: string[] = []

  if (process.env.DISCORD_WEBHOOK_URL) {
    tasks.push(
      fetch(process.env.DISCORD_WEBHOOK_URL, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: `🔵 ${title}\n${message}` }),
      }).then(r => { if (!r.ok) errors.push(`discord: ${r.status}`) })
    )
  }
  if (process.env.SLACK_WEBHOOK_URL) {
    tasks.push(
      fetch(process.env.SLACK_WEBHOOK_URL, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: `🔵 ${title}\n${message}` }),
      }).then(r => { if (!r.ok) errors.push(`slack: ${r.status}`) })
    )
  }
  if (process.env.PUSHOVER_USER && process.env.PUSHOVER_TOKEN) {
    tasks.push(
      fetch('https://api.pushover.net/1/messages.json', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: process.env.PUSHOVER_TOKEN, user: process.env.PUSHOVER_USER,
          title, message,
        }),
      }).then(r => { if (!r.ok) errors.push(`pushover: ${r.status}`) })
    )
  }
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    tasks.push(
      fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: `🔵 ${title}\n${message}` }),
      }).then(r => { if (!r.ok) errors.push(`telegram: ${r.status}`) })
    )
  }

  if (tasks.length === 0) {
    return NextResponse.json({ ok: false, error: 'No notification channel configured' }, { status: 400 })
  }

  await Promise.allSettled(tasks)
  return NextResponse.json({
    ok: errors.length === 0,
    sent: tasks.length,
    errors,
  })
}
