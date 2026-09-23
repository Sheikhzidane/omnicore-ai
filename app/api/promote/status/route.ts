import type { NextRequest } from 'next/server'
import { requirePlatformAdminReadApi } from '@/lib/auth/api'
import { NextResponse } from 'next/server'
import fs from 'node:fs/promises'
import path from 'node:path'

const PROMOTE_LOG = path.resolve(process.cwd(), 'scripts/promote-log.json')
const REVENUE_LOG = path.resolve(process.cwd(), 'scripts/revenue-log.json')

type Entry = {
  postedAt?:       string
  redditUrl?:      string
  submitUrl?:      string
  tweetId?:        string
  error?:          string
  dryRun?:         boolean
  requiresManual?: boolean
}
type PromoteLog = { posts: Record<string, Record<string, Record<string, Entry>>> }
type RevenueLog = { posts?: Array<{ id: number; title: string; devToUrl?: string; published?: boolean }> }

export async function GET(req: NextRequest) {
  const authz = await requirePlatformAdminReadApi(req)
  if (!authz.ok) return authz.response

  let promoteLog: PromoteLog = { posts: {} }
  let revenueLog: RevenueLog = {}

  try { promoteLog = JSON.parse(await fs.readFile(PROMOTE_LOG, 'utf8')) } catch {}
  try { revenueLog = JSON.parse(await fs.readFile(REVENUE_LOG, 'utf8')) } catch {}

  const posts = (revenueLog.posts ?? [])
    .filter(p => p.published && p.devToUrl)
    .map(p => {
      const promotions = promoteLog.posts[String(p.id)] ?? {}
      return {
        id:    p.id,
        title: p.title,
        url:   p.devToUrl,
        reddit:  Object.entries(promotions.reddit ?? {}).map(([sub, r]) => ({ sub, postedAt: r.postedAt, url: r.redditUrl, error: r.error, dryRun: r.dryRun })),
        twitter: promotions.twitter?.main ?? null,
        hn:      promotions.hn?.prepared ?? null,
      }
    })

  const configured = {
    reddit: Boolean(process.env.REDDIT_REFRESH_TOKEN && process.env.REDDIT_CLIENT_ID),
    twitter: Boolean(
      process.env.TWITTER_BEARER_TOKEN ||
      (process.env.TWITTER_CONSUMER_KEY && process.env.TWITTER_ACCESS_TOKEN)
    ),
    hn: true,
  }

  return NextResponse.json({ posts, configured })
}
