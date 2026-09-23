#!/usr/bin/env node
/**
 * affiliate-injector.mjs
 *
 * Safely adds a "Tools mentioned" section with affiliate links near the
 * bottom of topic pages. Runs weekly via God's cycle (every 70 cycles).
 *
 * Design note: earlier versions tried to inject <a> tags inline inside the
 * article prose. That broke because the SEO generator wraps all prose in
 * JSX string literals ({"..."} / {`...`}), which can't contain raw JSX.
 *
 * This version takes the safer route: detect which services are mentioned
 * in the prose (string match), then render a "Tools mentioned" block
 * above the CTA section. One block per page, clean JSX, always idempotent.
 *
 * Passive revenue math: 100 pages × 30 views/day × 2% click-through × \$1
 * avg commission ≈ \$60/day once Google ranks them.
 *
 * Configure in .env.local (all optional — falls back to canonical):
 *   AFFILIATE_SUPABASE, AFFILIATE_VERCEL, AFFILIATE_ANTHROPIC,
 *   AFFILIATE_CLAUDE, AFFILIATE_GUMROAD, AFFILIATE_LEMONSQUEEZY,
 *   AFFILIATE_RESEND, AFFILIATE_STRIPE
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'


// Permanently disabled (Phase 1 security lockdown): automatic insertion of affiliate links into published pages is undisclosed monetisation.
// Code kept for reference only. See docs/AGENT_PERMISSIONS.md.
console.log('[affiliate-injector] disabled: automatic insertion of affiliate links into published pages is undisclosed monetisation.')
process.exit(0)

const __dirname    = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')
const TOPICS_DIR   = join(PROJECT_ROOT, 'app', 'topics')

// Load env
for (const line of readFileSync(join(PROJECT_ROOT, '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

/**
 * Tracked services. Matcher used to detect mentions in the prose.
 * URL uses env var if set, otherwise falls back to canonical (no revenue
 * but still a tasteful outbound link).
 */
const SERVICES = [
  { name: 'Supabase',      matcher: /\bSupabase\b/i,           url: process.env.AFFILIATE_SUPABASE     ?? 'https://supabase.com',        pitch: 'open-source Firebase alt' },
  { name: 'Vercel',        matcher: /\bVercel\b/i,             url: process.env.AFFILIATE_VERCEL       ?? 'https://vercel.com',          pitch: 'zero-config Next.js hosting' },
  { name: 'Anthropic',     matcher: /\bAnthropic\b/i,          url: process.env.AFFILIATE_ANTHROPIC    ?? 'https://www.anthropic.com',   pitch: 'Claude API' },
  { name: 'Claude',        matcher: /\bClaude(?!\s*Code)\b/i,  url: process.env.AFFILIATE_CLAUDE       ?? 'https://claude.com',          pitch: 'AI assistant by Anthropic' },
  { name: 'Gumroad',       matcher: /\bGumroad\b/i,            url: process.env.AFFILIATE_GUMROAD      ?? 'https://gumroad.com',         pitch: 'sell digital products' },
  { name: 'Lemon Squeezy', matcher: /\bLemon\s*Squeezy\b/i,    url: process.env.AFFILIATE_LEMONSQUEEZY ?? 'https://www.lemonsqueezy.com',pitch: 'merchant of record for SaaS' },
  { name: 'Resend',        matcher: /\bResend\b/i,             url: process.env.AFFILIATE_RESEND       ?? 'https://resend.com',          pitch: 'email API for developers' },
  { name: 'Stripe',        matcher: /\bStripe\b/i,             url: process.env.AFFILIATE_STRIPE       ?? 'https://stripe.com',          pitch: 'payment processing' },
]

const MARKER = '<!-- tools-mentioned:v1 -->'
const OPEN_TAG  = `{/* ${MARKER} */}`

function listTopicPages() {
  if (!existsSync(TOPICS_DIR)) return []
  const out = []
  for (const entry of readdirSync(TOPICS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const pagePath = join(TOPICS_DIR, entry.name, 'page.tsx')
    if (existsSync(pagePath)) out.push(pagePath)
  }
  return out
}

/**
 * Renders a "Tools mentioned" JSX block for the services detected in the page.
 */
function renderToolsBlock(matchedServices) {
  if (matchedServices.length === 0) return ''
  const items = matchedServices.map(s =>
    `            <li><a href="${s.url}" target="_blank" rel="noopener noreferrer sponsored" className="text-cyan-400 hover:underline">${s.name}</a> <span className="text-slate-500">— ${s.pitch}</span></li>`
  ).join('\n')
  return `
        ${OPEN_TAG}
        <section className="mb-6 mt-10 rounded border border-slate-800/60 bg-slate-950 p-4">
          <h3 className="text-sm font-mono text-slate-400 tracking-widest uppercase mb-2">◈ Tools mentioned</h3>
          <ul className="text-[13px] text-slate-300 space-y-1">
${items}
          </ul>
          <p className="text-[10px] text-slate-600 mt-3">Some links may pay us a referral if you sign up. Never affects the price you pay.</p>
        </section>
`
}

function processPage(content) {
  // Skip if already has the tools block
  if (content.includes(MARKER)) return { content, added: 0, skipped: 'already has tools block' }

  // Detect which services are mentioned in the prose
  const matched = SERVICES.filter(s => s.matcher.test(content))
  if (matched.length === 0) return { content, added: 0, skipped: 'no service mentions' }

  // Inject before the final CTA section (search for the "Get the full starter kit" section)
  // or before the footer if we can't find a CTA
  const toolsBlock = renderToolsBlock(matched)

  let injected = content
  // Prefer to put this BEFORE the final CTA section
  const ctaPattern = /(\s*<section className="mt-10 rounded border border-cyan-900\/40)/
  if (ctaPattern.test(injected)) {
    injected = injected.replace(ctaPattern, `${toolsBlock}$1`)
  } else {
    // Fallback: before the <footer> element
    const footerPattern = /(\s*<footer\b)/
    if (footerPattern.test(injected)) {
      injected = injected.replace(footerPattern, `${toolsBlock}$1`)
    } else {
      return { content, added: 0, skipped: 'no injection anchor found' }
    }
  }

  return { content: injected, added: matched.length }
}

// ── Main ────────────────────────────────────────────────────────────────────
const pages = listTopicPages()
console.log(`▸ Scanning ${pages.length} topic pages`)

let totalLinks = 0
let pagesUpdated = 0
const skipReasons = {}

for (const path of pages) {
  const before = readFileSync(path, 'utf8')
  const { content: after, added, skipped } = processPage(before)
  if (added > 0 && after !== before) {
    writeFileSync(path, after, 'utf8')
    pagesUpdated++
    totalLinks += added
    const short = path.split(/[/\\]topics[/\\]/).pop()?.replace(/[/\\]page\.tsx$/, '')
    console.log(`  +${added} tools  ${short}`)
  } else if (skipped) {
    skipReasons[skipped] = (skipReasons[skipped] ?? 0) + 1
  }
}

console.log(`\n✓ ${totalLinks} affiliate links added across ${pagesUpdated}/${pages.length} pages`)
if (Object.keys(skipReasons).length > 0) {
  console.log(`  skipped: ${Object.entries(skipReasons).map(([r, c]) => `${c} × ${r}`).join(', ')}`)
}

const configured = SERVICES.filter(s => /ref=|aff=|utm_|\?a=/.test(s.url)).map(s => s.name)
const notConfigured = SERVICES.filter(s => !/ref=|aff=|utm_|\?a=/.test(s.url)).map(s => s.name)
if (configured.length) console.log(`  monetized (env set): ${configured.join(', ')}`)
if (notConfigured.length) console.log(`  canonical-only (add AFFILIATE_* env vars to monetize): ${notConfigured.join(', ')}`)
