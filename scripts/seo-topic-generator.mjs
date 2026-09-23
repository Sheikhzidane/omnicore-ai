#!/usr/bin/env node
/**
 * seo-topic-generator.mjs
 *
 * God-invocable generator that writes a new SEO-optimised landing page
 * to app/topics/<slug>/page.tsx. Each page:
 *
 *   - Targets one long-tail keyword in the autonomous-agents niche
 *   - 400-800 words of real content (no filler)
 *   - CTAs to /subscribe, Gumroad, and the live dashboard
 *   - Generated metadata (title, description, OG image)
 *   - Internal link back to root
 *
 * On commit + push, Vercel auto-deploys. No manual click anywhere.
 *
 * Run:   node scripts/seo-topic-generator.mjs [--batch 3]
 * Hooked by god-agent.mjs every 10 cycles.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Anthropic from '@anthropic-ai/sdk'
import { verifyTsxPage, verifyAndLog } from './lib-verify.mjs'
import { translateContent, TARGET_LANGS } from './lib-translator.mjs'

const __dirname    = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')
const TOPICS_DIR   = join(PROJECT_ROOT, 'app', 'topics')

// Load env
for (const line of readFileSync(join(PROJECT_ROOT, '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// Seed topics — God picks one not yet covered. Covers different keyword families.
// Expanded to 60+ long-tail keywords spanning AI agents, Next.js, Supabase,
// Claude, cost optimisation, security, debugging, and autonomous workflows.
const SEED_TOPICS = [
  // ── Core agent patterns ────────────────────────────────────────────────────
  { slug: 'how-to-build-autonomous-ai-agents-claude',        h1: 'How to Build Autonomous AI Agents with Claude' },
  { slug: 'self-improving-ai-orchestrator-pattern',           h1: 'The Self-Improving AI Orchestrator Pattern' },
  { slug: 'nextjs-14-supabase-multi-agent-systems',           h1: 'Next.js 14 + Supabase for Multi-Agent AI Systems' },
  { slug: 'claude-tool-use-best-practices',                   h1: 'Claude Tool Use — Production Best Practices' },
  { slug: 'real-cost-running-autonomous-ai-agents',           h1: 'The Real Cost of Running Autonomous AI Agents 24/7' },
  { slug: 'task-inbox-approval-workflow-ai-agents',           h1: 'Adding a Task Inbox Approval Workflow to AI Agents' },
  { slug: 'supabase-realtime-agent-dashboards',               h1: 'Supabase Realtime for AI Agent Dashboards' },
  { slug: 'pm2-long-running-ai-agent-processes',              h1: 'Running AI Agents 24/7 with PM2' },
  { slug: 'auto-commit-auto-revert-ai-code',                  h1: 'Auto-Commit and Auto-Revert for AI-Generated Code' },
  { slug: 'building-self-improving-god-agent',                h1: 'Building a Self-Improving God Agent with Claude' },
  { slug: 'ai-agent-cost-controls-daily-cap-circuit-breaker', h1: 'Cost Controls for AI Agents — Daily Cap + Circuit Breaker' },
  { slug: 'ai-agent-stuck-task-watchdog',                     h1: 'Building a Stuck-Task Watchdog for AI Agent Pools' },
  { slug: 'ai-agent-memory-jaccard-dedup',                    h1: 'AI Agent Memory — Dedup Lessons with Jaccard Similarity' },
  { slug: 'curiosity-driven-agent-exploration',               h1: 'Curiosity-Driven Exploration in AI Agents' },
  { slug: 'meta-reflection-ai-agent-self-improvement',        h1: 'Meta-Reflection as an AI Agent Self-Improvement Primitive' },
  { slug: 'discord-slack-telegram-ai-agent-notifications',    h1: 'Notifying Yourself When Your AI Agent Breaks' },
  { slug: 'ai-agent-pixel-office-visualization',              h1: 'Visualising AI Agents with a Pixel-Art Office' },
  { slug: 'god-agent-prompt-engineering-patterns',            h1: 'Prompt Engineering Patterns for Orchestrator Agents' },
  { slug: 'autonomous-ai-revenue-engine',                     h1: 'Building an Autonomous AI Revenue Engine' },
  { slug: 'multi-agent-system-typescript-zero-to-one',        h1: 'Zero-to-One Multi-Agent AI System in TypeScript' },

  // ── Next.js specific ───────────────────────────────────────────────────────
  { slug: 'nextjs-14-app-router-ai-dashboard',                h1: 'Building an AI Dashboard with Next.js 14 App Router' },
  { slug: 'nextjs-middleware-rate-limiting',                  h1: 'Rate Limiting API Routes in Next.js Middleware' },
  { slug: 'nextjs-realtime-with-supabase',                    h1: 'Real-Time Features in Next.js with Supabase Realtime' },
  { slug: 'nextjs-server-actions-ai-agents',                  h1: 'Next.js Server Actions for AI Agent Triggers' },
  { slug: 'nextjs-vercel-cold-start-optimization',            h1: 'Reducing Next.js Cold Starts on Vercel' },
  { slug: 'nextjs-typescript-strict-mode-agents',             h1: 'Strict-Mode TypeScript for AI Agent Projects' },

  // ── Supabase specific ──────────────────────────────────────────────────────
  { slug: 'supabase-rls-policies-ai-agents',                  h1: 'Supabase RLS Policies for AI Agent Writes' },
  { slug: 'supabase-pgvector-agent-memory',                   h1: 'Using pgvector for AI Agent Semantic Memory' },
  { slug: 'supabase-realtime-subscriptions-nextjs',           h1: 'Supabase Realtime Subscriptions in Next.js App Router' },
  { slug: 'supabase-migrations-best-practices',               h1: 'Supabase Migrations — Numbering and Ordering' },
  { slug: 'supabase-edge-functions-ai-agents',                h1: 'Supabase Edge Functions for AI Agent Webhooks' },
  { slug: 'supabase-service-role-vs-anon-key',                h1: 'When to Use Supabase Service Role vs Anon Key' },

  // ── Claude / Anthropic specific ────────────────────────────────────────────
  { slug: 'claude-opus-vs-sonnet-vs-haiku-routing',           h1: 'Claude Opus vs Sonnet vs Haiku — Smart Model Routing' },
  { slug: 'claude-api-tier-1-vs-tier-2-limits',               h1: 'Claude API Tier 1 vs Tier 2 Rate Limits' },
  { slug: 'claude-prompt-caching-cost-reduction',             h1: 'Cutting Claude API Costs with Prompt Caching' },
  { slug: 'claude-extended-thinking-agent-reasoning',         h1: 'Claude Extended Thinking for Agent Reasoning' },
  { slug: 'claude-tool-use-parallel-execution',               h1: 'Parallel Tool Execution Patterns in Claude' },
  { slug: 'claude-context-window-200k-management',            h1: 'Managing Claude\'s 200k Context Window at Scale' },
  { slug: 'claude-citation-fact-checking',                    h1: 'Claude Citations for AI Agent Fact-Checking' },
  { slug: 'claude-batch-api-cost-50-percent-savings',         h1: 'Claude Batch API — 50% Cost Reduction for Async Work' },

  // ── Cost & ops ─────────────────────────────────────────────────────────────
  { slug: 'llm-api-cost-tracking-dashboard',                  h1: 'Building an LLM API Cost Tracker Dashboard' },
  { slug: 'ai-agent-context-compression-techniques',          h1: 'Context Compression for Long-Running AI Agents' },
  { slug: 'reducing-ai-agent-token-spend',                    h1: 'Five Techniques for Reducing AI Agent Token Spend' },
  { slug: 'ai-agent-observability-langfuse-logfire',          h1: 'AI Agent Observability with Langfuse and Logfire' },
  { slug: 'vercel-ai-sdk-vs-raw-anthropic-api',               h1: 'Vercel AI SDK vs Raw Anthropic API — Pros and Cons' },
  { slug: 'ai-agent-debugging-trace-replay',                  h1: 'Debugging AI Agents with Trace Replay' },

  // ── Security ───────────────────────────────────────────────────────────────
  { slug: 'ai-agent-prompt-injection-defense',                h1: 'Defending AI Agents Against Prompt Injection' },
  { slug: 'owasp-top-10-for-ai-agents',                       h1: 'OWASP Top 10 Applied to AI Agent Systems' },
  { slug: 'securing-llm-tool-calls-production',               h1: 'Securing LLM Tool Calls in Production' },
  { slug: 'ai-agent-rate-limiting-circuit-breakers',          h1: 'Rate Limiting and Circuit Breakers for AI Agents' },

  // ── Autonomous workflows ───────────────────────────────────────────────────
  { slug: 'ai-agent-writes-own-code-auto-revert',             h1: 'AI Agents That Edit Their Own Code Safely' },
  { slug: 'autonomous-dev-to-article-writer',                 h1: 'Building an Autonomous Dev.to Article Writer' },
  { slug: 'ai-agent-reddit-auto-post-oauth',                  h1: 'Auto-Posting to Reddit from an AI Agent via OAuth' },
  { slug: 'autonomous-seo-landing-page-farm',                 h1: 'Building an Autonomous SEO Landing Page Farm' },
  { slug: 'ai-agent-self-directed-goals',                     h1: 'Giving AI Agents Self-Directed Goals' },
  { slug: 'ai-agent-email-newsletter-resend',                 h1: 'Autonomous Email Newsletters with Resend and AI' },

  // ── Developer experience ───────────────────────────────────────────────────
  { slug: 'command-palette-ctrl-k-dashboard',                 h1: 'Adding a Command Palette (Ctrl+K) to Your Dashboard' },
  { slug: 'pixel-art-ui-for-developer-tools',                 h1: 'Pixel-Art UI for Developer Dashboards' },
  { slug: 'github-actions-nightly-supabase-backup',           h1: 'Nightly Supabase Backups via GitHub Actions' },
  { slug: 'jaccard-similarity-ai-agent-retrieval',            h1: 'Jaccard Similarity for AI Agent Lesson Retrieval' },

  // ── Indie dev economics ────────────────────────────────────────────────────
  { slug: 'indie-dev-autonomous-ai-side-project',             h1: 'The Indie Dev Playbook for Autonomous AI Side Projects' },
  { slug: 'ai-agent-passive-income-seo-strategy',             h1: 'Passive Income Through AI-Generated SEO Content' },
  { slug: 'gumroad-vs-lemon-squeezy-vs-stripe-for-devs',      h1: 'Gumroad vs Lemon Squeezy vs Stripe — Which to Pick' },
  { slug: 'selling-ai-agent-code-gumroad',                    h1: 'Selling AI Agent Code on Gumroad — A Playbook' },
]

const SITE_URL  = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://task-dashboard-sigma-three.vercel.app'
const REPO_URL  = process.env.GITHUB_REPO_URL     ?? 'https://github.com/lewisallena17/pantheon'
const GUMROAD   = process.env.GUMROAD_URL         ?? 'https://ltagb.gumroad.com/l/gferg'

function getExistingSlugs() {
  if (!existsSync(TOPICS_DIR)) return new Set()
  return new Set(readdirSync(TOPICS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name))
}

async function generatePage(topic) {
  const prompt = `You're writing a single SEO landing page for the keyword "${topic.h1}".

Audience: indie developers and founders building AI agent systems with Claude, Next.js, Supabase.

Write genuine, useful content — no fluff, no "in today's fast-paced world". 400-700 words total. Include:
- One-sentence hook that promises concrete value
- 4-6 H2 sections with specific technical content
- 1 short code block example where relevant (Next.js, TypeScript, or SQL)
- An "Open-source implementation" section referencing the real pantheon repo at github.com/lewisallena17/pantheon
- A final "Get the full starter kit" CTA

Output ONLY valid JSON. No markdown, no preamble:
{
  "metaTitle":       "SEO title, 50-60 chars, includes keyword",
  "metaDescription": "155 chars, includes keyword, compelling",
  "intro":           "one-paragraph hook",
  "sections":        [ { "heading": "H2 text", "bodyParagraphs": ["para 1", "para 2"], "code": "optional code block string or null" } ],
  "takeaway":        "one-sentence summary with CTA language"
}`

  // Haiku — ~3× cheaper than Sonnet, output is good enough for
  // SEO landing pages (keyword-optimised structure matters more than prose
  // flourish). Switch back to claude-sonnet-4-6 if you start seeing shallow
  // content in Google Search Console analytics.
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2500,
    messages: [{ role: 'user', content: prompt }],
  })
  const text = response.content[0]?.type === 'text' ? response.content[0].text : ''
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('no JSON in response')
  return JSON.parse(match[0])
}

function renderPage(topic, content, locale = 'en') {
  const sectionsJsx = content.sections.map(s => {
    const paragraphs = (s.bodyParagraphs ?? []).map(p => {
      const safe = p.replace(/`/g, '\\`').replace(/\$/g, '\\$')
      return `          <p className="text-slate-300 leading-relaxed mb-3">{\`${safe}\`}</p>`
    }).join('\n')
    const codeBlock = s.code
      ? `          <pre className="bg-slate-950 border border-slate-800/60 rounded p-3 text-[11px] text-slate-300 overflow-x-auto my-4"><code>{\`${s.code.replace(/`/g, '\\`').replace(/\$/g, '\\$')}\`}</code></pre>`
      : ''
    const safeHeading = s.heading.replace(/"/g, '\\"')
    return `        <section className="mb-6">
          <h2 className="text-xl font-bold text-slate-100 mt-8 mb-3">{"${safeHeading}"}</h2>
${paragraphs}
${codeBlock}
        </section>`
  }).join('\n')

  const safeIntro    = content.intro.replace(/`/g, '\\`').replace(/\$/g, '\\$')
  const safeTakeaway = content.takeaway.replace(/`/g, '\\`').replace(/\$/g, '\\$')
  const safeH1       = topic.h1.replace(/"/g, '\\"')
  const safeTitle    = content.metaTitle.replace(/"/g, '\\"').replace(/'/g, "\\'")
  const safeDesc     = content.metaDescription.replace(/"/g, '\\"').replace(/'/g, "\\'")

  return `import type { Metadata } from 'next'
import Link from 'next/link'
import DisplayAd from '@/components/DisplayAd'
import AmazonGeoSwap from '@/components/AmazonGeoSwap'

import { assertOpsAgentsEnabled } from './lib-agent-permissions.mjs'

// Kill switch: ops agents are off unless OPS_AGENTS_ENABLED=true.
assertOpsAgentsEnabled('seo-topic-generator')

const CANONICAL_PATH = '${locale === 'en' ? `/topics/${topic.slug}` : `/${locale}/topics/${topic.slug}`}'

export const metadata: Metadata = {
  title:       '${safeTitle}',
  description: '${safeDesc}',
  alternates: {
    canonical: '${SITE_URL}' + CANONICAL_PATH,
    languages: {
      'en':    '${SITE_URL}/topics/${topic.slug}',
      'es':    '${SITE_URL}/es/topics/${topic.slug}',
      'de':    '${SITE_URL}/de/topics/${topic.slug}',
      'fr':    '${SITE_URL}/fr/topics/${topic.slug}',
      'x-default': '${SITE_URL}/topics/${topic.slug}',
    },
  },
  openGraph: {
    title:       '${safeTitle}',
    description: '${safeDesc}',
    type:        'article',
    locale:      '${locale === 'en' ? 'en_US' : locale === 'es' ? 'es_ES' : locale === 'de' ? 'de_DE' : locale === 'fr' ? 'fr_FR' : 'en_US'}',
    url:         '${SITE_URL}' + CANONICAL_PATH,
  },
  twitter: { card: 'summary_large_image', title: '${safeTitle}', description: '${safeDesc}' },
}

export default function Topic() {
  return (
    <main className="min-h-screen bg-slate-950 px-4 py-10">
      <AmazonGeoSwap />
      <article className="max-w-3xl mx-auto">
        <nav className="text-[10px] font-mono text-slate-500 mb-6">
          <Link href="/" className="hover:text-cyan-400">◈ pantheon</Link>
          <span className="mx-2">/</span>
          <Link href="/topics" className="hover:text-cyan-400">topics</Link>
        </nav>

        <h1 className="text-3xl font-bold text-slate-100 mb-4 leading-tight">{"${safeH1}"}</h1>

        <p className="text-slate-300 leading-relaxed mb-8 text-lg">{\`${safeIntro}\`}</p>

        {/* Above-fold display ad — renders placeholder until NEXT_PUBLIC_ADSENSE_CLIENT_ID is set */}
        <DisplayAd slot="topic-top" format="auto" className="my-6" />

${sectionsJsx}

        {/* Mid-article display ad */}
        <DisplayAd slot="topic-mid" format="auto" className="my-8" />

        <section className="mb-6">
          <h2 className="text-xl font-bold text-slate-100 mt-8 mb-3">Open-source implementation</h2>
          <p className="text-slate-300 leading-relaxed mb-3">
            Everything in this article runs in{' '}
            <a href="${REPO_URL}" className="text-cyan-400 hover:underline" target="_blank" rel="noopener noreferrer">pantheon</a> — a production-ready Next.js + Supabase + Claude starter. Clone it, deploy to Vercel, run PM2. The dashboard auto-commits every agent edit and reverts itself if TypeScript breaks.
          </p>
        </section>

        <section className="mt-10 rounded border border-cyan-900/40 bg-cyan-950/20 p-6 text-center">
          <h3 className="text-lg font-bold text-cyan-300 mb-2">Get the full starter kit</h3>
          <p className="text-slate-300 mb-4 text-sm">{\`${safeTakeaway}\`}</p>
          <div className="flex flex-wrap gap-3 justify-center">
            <a href="${GUMROAD}" target="_blank" rel="noopener noreferrer"
               className="inline-block text-sm font-mono px-4 py-2 rounded border border-amber-700 bg-amber-950/40 text-amber-300 hover:bg-amber-950/60">
              🛒 Buy on Gumroad — \$39
            </a>
            <Link href="/subscribe"
                  className="inline-block text-sm font-mono px-4 py-2 rounded border border-cyan-700 bg-cyan-950/40 text-cyan-300 hover:bg-cyan-950/60">
              📧 Subscribe for updates
            </Link>
            <Link href="/"
                  className="inline-block text-sm font-mono px-4 py-2 rounded border border-slate-700 text-slate-400 hover:bg-slate-800/40">
              🏠 Live dashboard
            </Link>
          </div>
        </section>

        <footer className="mt-10 pt-6 border-t border-slate-800/60 text-[11px] font-mono text-slate-500 space-y-2">
          <p>Part of{' '}<Link href="/topics" className="text-cyan-500 hover:underline">the pantheon knowledge base</Link>. Articles are generated + updated by the god agent itself.</p>
          <div className="flex gap-4 flex-wrap pt-2">
            <Link href="/" className="hover:text-cyan-400">home</Link>
            <Link href="/topics" className="hover:text-cyan-400">articles</Link>
            <Link href="/about" className="hover:text-cyan-400">about</Link>
            <Link href="/privacy" className="hover:text-cyan-400">privacy</Link>
            <Link href="/contact" className="hover:text-cyan-400">contact</Link>
          </div>
        </footer>
      </article>
    </main>
  )
}
`
}

async function generateOne() {
  const existing = getExistingSlugs()
  const available = SEED_TOPICS.filter(t => !existing.has(t.slug))
  if (available.length === 0) {
    console.log('[SEO] all seed topics generated — add more to SEED_TOPICS')
    return null
  }
  const topic = available[Math.floor(Math.random() * available.length)]

  console.log(`[SEO] generating: ${topic.h1}`)
  let content
  try {
    content = await generatePage(topic)
  } catch (e) {
    console.log(`[SEO] generate failed: ${e.message}`)
    return null
  }

  const dir = join(TOPICS_DIR, topic.slug)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const pagePath = join(dir, 'page.tsx')
  writeFileSync(pagePath, renderPage(topic, content, 'en'), 'utf8')

  console.log(`[SEO] wrote ${pagePath}`)

  // Verify the English file we just wrote actually has the expected structure
  await verifyAndLog(PROJECT_ROOT, 'seo-page',
    () => Promise.resolve(verifyTsxPage(pagePath, { mustContain: [topic.h1.slice(0, 30)] })),
    { slug: topic.slug, h1: topic.h1.slice(0, 80) },
  ).catch(() => {})

  // ── Translate + write localised versions (es/de/fr) ──
  // One Haiku call per language (~$0.005 each). Writes to
  // app/{lang}/topics/{slug}/page.tsx with hreflang + canonical set.
  // Falls back to skip-language-silently on any failure — English
  // page is the source of truth.
  if (process.env.DISABLE_SEO_TRANSLATIONS !== 'true') {
    for (const lang of TARGET_LANGS) {
      try {
        const translated = await translateContent(anthropic, content, lang.code)
        if (!translated) { console.log(`[SEO] ${lang.code}: skipped (translation failed)`); continue }

        // Construct a "translated topic" — slug stays identical, H1 swaps to
        // the translated metaTitle for the <h1> + verifier.
        const localTopic = { ...topic, h1: translated.metaTitle.replace(/^["']|["']$/g, '').slice(0, 120) }

        const localDir = join(PROJECT_ROOT, 'app', lang.code, 'topics', topic.slug)
        if (!existsSync(localDir)) mkdirSync(localDir, { recursive: true })
        const localPath = join(localDir, 'page.tsx')
        writeFileSync(localPath, renderPage(localTopic, translated, lang.code), 'utf8')
        console.log(`[SEO] wrote ${lang.code}: ${localPath}`)

        await verifyAndLog(PROJECT_ROOT, 'seo-page',
          () => Promise.resolve(verifyTsxPage(localPath)),
          { slug: topic.slug, lang: lang.code },
        ).catch(() => {})
      } catch (e) {
        console.log(`[SEO] ${lang.code}: translation error: ${e.message?.slice(0, 80)}`)
      }
    }
  }

  return { topic, path: pagePath }
}

// ── Entrypoint ──────────────────────────────────────────────────────────────
const batchArg = process.argv.find(a => a.startsWith('--batch'))
const batch = batchArg ? Number(batchArg.split('=')[1] ?? process.argv[process.argv.indexOf(batchArg) + 1] ?? 1) : 1

const generated = []
for (let i = 0; i < Math.max(1, Math.min(5, batch)); i++) {
  const r = await generateOne()
  if (r) generated.push(r)
  if (i < batch - 1) await new Promise(r => setTimeout(r, 2000))
}

// Ping IndexNow for the freshly-generated pages so Bing/Google find them in
// hours instead of days. Best-effort; failures don't bubble up.
if (generated.length > 0) {
  try {
    const { pingIndexNow } = await import('./indexnow.mjs')
    const base = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://task-dashboard-sigma-three.vercel.app'
    const urls = generated.map(g => `${base}/topics/${g.topic.slug}`)
    await pingIndexNow(urls)
  } catch (e) {
    console.log('[SEO-GEN] indexnow ping skipped:', e.message?.slice(0, 80))
  }
}

if (generated.length === 0) {
  console.log('[SEO] nothing generated')
  process.exit(0)
}

// Commit what was created
try {
  execSync(`git add app/topics`, { cwd: PROJECT_ROOT })
  const titles = generated.map(g => g.topic.slug).join(', ')
  execSync(
    `git commit -m "seo: auto-generate ${generated.length} topic page${generated.length > 1 ? 's' : ''} (${titles})"`,
    { cwd: PROJECT_ROOT, stdio: 'pipe' },
  )
  console.log(`[SEO] committed ${generated.length} page(s)`)
  // Push if remote exists
  try {
    execSync(`git push`, { cwd: PROJECT_ROOT, stdio: 'pipe' })
    console.log(`[SEO] pushed to origin — Vercel will redeploy`)
  } catch {
    console.log(`[SEO] git push skipped (no remote or auth issue)`)
  }
} catch (e) {
  console.log(`[SEO] commit failed: ${e.message?.slice(0, 100)}`)
}
