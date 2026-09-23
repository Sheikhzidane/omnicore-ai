/**
 * promote-agent.mjs — autonomous article promoter
 *
 * Reads revenue-log.json for published articles and promotes them to:
 *   - Reddit (via OAuth refresh token)
 *   - Twitter/X (via v2 API bearer or user OAuth)
 *   - HackerNews (prepares submission URL; posting requires login)
 *
 * Runs every PROMOTE_INTERVAL_MIN minutes (default 30).
 *
 * pm2 start scripts/promote-agent.mjs --name promote
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'


// Permanently disabled (Phase 1 security lockdown): automated Reddit posting conflicts with the platform anti-spam policy.
// Code kept for reference only. See docs/AGENT_PERMISSIONS.md.
console.log('[promote-agent] disabled: automated Reddit posting conflicts with the platform anti-spam policy.')
process.exit(0)

const __dirname    = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')
const REVENUE_LOG  = join(__dirname, 'revenue-log.json')
const PROMOTE_LOG  = join(__dirname, 'promote-log.json')

// Load env
try {
  const envFile = readFileSync(join(PROJECT_ROOT, '.env.local'), 'utf8')
  for (const line of envFile.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch {}

const INTERVAL_MIN = Number(process.env.PROMOTE_INTERVAL_MIN ?? 30)
const DRY_RUN      = process.env.PROMOTE_DRY_RUN === 'true'

const REDDIT = {
  clientId:     process.env.REDDIT_CLIENT_ID,
  clientSecret: process.env.REDDIT_CLIENT_SECRET,
  refreshToken: process.env.REDDIT_REFRESH_TOKEN,
  userAgent:    process.env.REDDIT_USER_AGENT ?? 'task-dashboard-promoter/1.0',
  subreddits:   (process.env.REDDIT_SUBREDDITS ?? 'sideproject,SideProject').split(',').map(s => s.trim()).filter(Boolean),
}

const TWITTER = {
  bearer:       process.env.TWITTER_BEARER_TOKEN,
  consumerKey:  process.env.TWITTER_CONSUMER_KEY,
  consumerSec:  process.env.TWITTER_CONSUMER_SECRET,
  accessToken:  process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_SECRET,
}

// ── Promote log (tracks what's been posted where) ────────────────────────────
function loadPromoteLog() {
  if (!existsSync(PROMOTE_LOG)) return { posts: {} }
  try { return JSON.parse(readFileSync(PROMOTE_LOG, 'utf8')) }
  catch { return { posts: {} } }
}

function savePromoteLog(log) {
  writeFileSync(PROMOTE_LOG, JSON.stringify(log, null, 2))
}

function hasPosted(log, articleId, platform, target) {
  const key = `${articleId}`
  return log.posts[key]?.[platform]?.[target]?.postedAt
}

function markPosted(log, articleId, platform, target, result) {
  const key = `${articleId}`
  if (!log.posts[key]) log.posts[key] = {}
  if (!log.posts[key][platform]) log.posts[key][platform] = {}
  log.posts[key][platform][target] = { ...result, postedAt: new Date().toISOString() }
}

// ── Reddit ───────────────────────────────────────────────────────────────────
let redditAccessToken = null
let redditTokenExpires = 0

async function getRedditToken() {
  if (redditAccessToken && Date.now() < redditTokenExpires) return redditAccessToken
  if (!REDDIT.clientId || !REDDIT.clientSecret || !REDDIT.refreshToken) return null

  const basic = Buffer.from(`${REDDIT.clientId}:${REDDIT.clientSecret}`).toString('base64')
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'User-Agent':    REDDIT.userAgent,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: REDDIT.refreshToken,
    }),
  })
  if (!res.ok) {
    console.log('[PROMOTE-REDDIT] token refresh failed:', res.status, await res.text())
    return null
  }
  const data = await res.json()
  redditAccessToken = data.access_token
  redditTokenExpires = Date.now() + (data.expires_in - 60) * 1000
  return redditAccessToken
}

async function redditSubmit({ subreddit, title, url }) {
  if (DRY_RUN) {
    console.log(`[PROMOTE-REDDIT] DRY-RUN would post to r/${subreddit}: "${title}"`)
    return { dryRun: true, subreddit, title, url }
  }
  const token = await getRedditToken()
  if (!token) return { error: 'no token' }

  const res = await fetch('https://oauth.reddit.com/api/submit', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'User-Agent':    REDDIT.userAgent,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      sr:         subreddit,
      kind:       'link',
      title,
      url,
      api_type:   'json',
      resubmit:   'false',
      sendreplies: 'true',
    }),
  })
  const text = await res.text()
  if (!res.ok) return { error: `reddit ${res.status}: ${text.slice(0, 200)}` }

  try {
    const data = JSON.parse(text)
    const errs = data?.json?.errors ?? []
    if (errs.length > 0) return { error: errs[0].join(': ') }
    return { ok: true, redditUrl: data?.json?.data?.url, name: data?.json?.data?.name }
  } catch {
    return { error: `parse: ${text.slice(0, 200)}` }
  }
}

// ── Twitter / X ──────────────────────────────────────────────────────────────
async function twitterPost({ text }) {
  if (DRY_RUN) {
    console.log(`[PROMOTE-TWITTER] DRY-RUN would tweet: "${text}"`)
    return { dryRun: true, text }
  }

  // Path A: user-context via OAuth 1.0a (tweet.write needed)
  if (TWITTER.consumerKey && TWITTER.accessToken) {
    const crypto = await import('node:crypto')
    const url = 'https://api.twitter.com/2/tweets'
    const params = {
      oauth_consumer_key:     TWITTER.consumerKey,
      oauth_nonce:            crypto.randomBytes(16).toString('hex'),
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp:        Math.floor(Date.now() / 1000).toString(),
      oauth_token:            TWITTER.accessToken,
      oauth_version:          '1.0',
    }
    const paramStr = Object.keys(params).sort().map(k =>
      `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`
    ).join('&')
    const base = `POST&${encodeURIComponent(url)}&${encodeURIComponent(paramStr)}`
    const key  = `${encodeURIComponent(TWITTER.consumerSec)}&${encodeURIComponent(TWITTER.accessSecret)}`
    const sig  = crypto.createHmac('sha1', key).update(base).digest('base64')
    const header = 'OAuth ' + Object.entries({ ...params, oauth_signature: sig })
      .map(([k, v]) => `${encodeURIComponent(k)}="${encodeURIComponent(v)}"`).join(', ')

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': header, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    if (!res.ok) return { error: `twitter ${res.status}: ${(await res.text()).slice(0, 200)}` }
    const data = await res.json()
    return { ok: true, tweetId: data?.data?.id }
  }

  return { error: 'no twitter credentials' }
}

// ── HackerNews (prepare URL only — posting needs login + captcha) ────────────
function hnSubmitUrl({ title, url }) {
  const params = new URLSearchParams({ t: title, u: url })
  return `https://news.ycombinator.com/submitlink?${params}`
}

// ── Main loop ────────────────────────────────────────────────────────────────
async function promote() {
  if (!existsSync(REVENUE_LOG)) {
    console.log('[PROMOTE] no revenue-log.json yet')
    return
  }
  const revenue = JSON.parse(readFileSync(REVENUE_LOG, 'utf8'))
  const log     = loadPromoteLog()

  const articles = (revenue.posts ?? []).filter(p => p.published && p.devToUrl)
  if (articles.length === 0) {
    console.log('[PROMOTE] no published articles to promote')
    return
  }

  console.log(`[PROMOTE] ${articles.length} article(s) · ${REDDIT.subreddits.length} subreddit(s) · dry=${DRY_RUN}`)

  for (const article of articles) {
    // Reddit — post once per subreddit
    if (REDDIT.refreshToken) {
      for (const sub of REDDIT.subreddits) {
        if (hasPosted(log, article.id, 'reddit', sub)) continue

        const result = await redditSubmit({
          subreddit: sub,
          title:     article.title.slice(0, 300),
          url:       article.devToUrl,
        })
        if (result.ok || result.dryRun) {
          console.log(`[PROMOTE-REDDIT] ${article.id} → r/${sub}: ${result.redditUrl ?? 'dry-run'}`)
          markPosted(log, article.id, 'reddit', sub, result)
          savePromoteLog(log)
          await new Promise(r => setTimeout(r, 10_000)) // spacing — don't spam
        } else {
          console.log(`[PROMOTE-REDDIT] ${article.id} → r/${sub}: ${result.error}`)
        }
      }
    }

    // Twitter — once per article
    if ((TWITTER.consumerKey && TWITTER.accessToken) || TWITTER.bearer) {
      if (!hasPosted(log, article.id, 'twitter', 'main')) {
        const text = `${article.title.slice(0, 230)}\n\n${article.devToUrl}`
        const result = await twitterPost({ text })
        if (result.ok || result.dryRun) {
          console.log(`[PROMOTE-TWITTER] ${article.id} → tweeted`)
          markPosted(log, article.id, 'twitter', 'main', result)
          savePromoteLog(log)
        } else {
          console.log(`[PROMOTE-TWITTER] ${article.id} → ${result.error}`)
        }
      }
    }

    // HackerNews — prepare submission URL (user clicks)
    if (!hasPosted(log, article.id, 'hn', 'prepared')) {
      const submitUrl = hnSubmitUrl({ title: article.title, url: article.devToUrl })
      markPosted(log, article.id, 'hn', 'prepared', { submitUrl, requiresManual: true })
      savePromoteLog(log)
      console.log(`[PROMOTE-HN] ${article.id} → prepared: ${submitUrl}`)
    }
  }
}

async function main() {
  console.log(`[PROMOTE] starting · interval=${INTERVAL_MIN}min · dry=${DRY_RUN}`)
  console.log(`[PROMOTE] reddit=${REDDIT.refreshToken ? 'on' : 'off'} twitter=${(TWITTER.accessToken || TWITTER.bearer) ? 'on' : 'off'}`)

  // Run once at startup, then on interval
  while (true) {
    try { await promote() }
    catch (e) { console.log('[PROMOTE] error:', e.message) }
    await new Promise(r => setTimeout(r, INTERVAL_MIN * 60 * 1000))
  }
}

main()
