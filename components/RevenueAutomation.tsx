'use client'

import { useEffect, useState, useCallback } from 'react'

interface PromoteStatus {
  configured: { reddit: boolean; twitter: boolean; hn: boolean }
  posts: Array<{
    id:      number
    title:   string
    url:     string
    reddit:  Array<{ sub: string; postedAt?: string; url?: string; error?: string; dryRun?: boolean }>
    twitter: { postedAt?: string; tweetId?: string; dryRun?: boolean } | null
    hn:      { postedAt?: string; submitUrl?: string; requiresManual?: boolean } | null
  }>
}

interface GumroadProduct {
  index:         number
  name:          string
  tagline:       string
  description:   string
  included:      string[]
  price:         number
  generatedAt:   string
  publishedUrl?: string
  publishedAt?:  string
  isPublished:   boolean
}

export default function RevenueAutomation() {
  const [promote, setPromote]   = useState<PromoteStatus | null>(null)
  const [gumroad, setGumroad]   = useState<GumroadProduct[]>([])
  const [copied,  setCopied]    = useState<string | null>(null)
  const [expanded, setExpanded] = useState<number | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [p, g] = await Promise.all([
        fetch('/api/promote/status', { cache: 'no-store' }).then(r => r.json()),
        fetch('/api/revenue/gumroad', { cache: 'no-store' }).then(r => r.json()),
      ])
      setPromote(p)
      setGumroad(g.products ?? [])
    } catch {}
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 20_000)
    return () => clearInterval(id)
  }, [refresh])

  function copyToClipboard(text: string, label: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(label)
      setTimeout(() => setCopied(null), 1800)
    })
  }

  async function markPublished(index: number) {
    const url = prompt('Paste the Gumroad product URL after you publish:')
    if (!url) return
    await fetch('/api/revenue/gumroad', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ index, publishedUrl: url }),
    })
    refresh()
  }

  const unPublishedGumroad = gumroad.filter(g => !g.isPublished)
  const publishedGumroad   = gumroad.filter(g =>  g.isPublished)

  return (
    <div className="rounded border border-slate-800/60 bg-black/40 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800/60 bg-black/60">
        <span className="text-xs font-mono tracking-[0.2em] text-slate-500 uppercase">◈ Revenue Automation</span>
        <div className="flex items-center gap-2 text-[9px] font-mono">
          <span className={promote?.configured.reddit ? 'text-green-400' : 'text-slate-600'}>
            {promote?.configured.reddit ? '● reddit' : '○ reddit'}
          </span>
          <span className={promote?.configured.twitter ? 'text-green-400' : 'text-slate-600'}>
            {promote?.configured.twitter ? '● twitter' : '○ twitter'}
          </span>
          <span className="text-green-400">● hn (manual)</span>
          <span className={unPublishedGumroad.length > 0 ? 'text-amber-400' : 'text-slate-600'}>
            {unPublishedGumroad.length > 0 ? `● gumroad (${unPublishedGumroad.length} drafts)` : '○ gumroad'}
          </span>
        </div>
      </div>

      {/* ── Promotions ──────────────────────────────────────────────────────── */}
      <div className="px-4 py-3 border-b border-slate-800/40">
        <div className="text-[10px] font-mono text-slate-500 tracking-[0.2em] uppercase mb-2">Article Promotions</div>
        {!promote || promote.posts.length === 0 ? (
          <div className="text-[11px] font-mono text-slate-600">No published articles yet</div>
        ) : (
          <div className="space-y-2">
            {promote.posts.map(p => (
              <div key={p.id} className="border border-slate-800/40 rounded p-2">
                <div className="flex items-center justify-between gap-3">
                  <a href={p.url} target="_blank" rel="noopener noreferrer"
                     className="text-xs text-slate-300 hover:text-cyan-400 truncate flex-1">
                    {p.title}
                  </a>
                  <div className="flex gap-1.5 shrink-0">
                    {p.reddit.map(r => (
                      <span key={r.sub}
                        className={`text-[9px] font-mono px-1.5 py-0.5 rounded border ${
                          r.url ? 'border-green-900/50 text-green-400' :
                          r.error ? 'border-red-900/50 text-red-400' :
                          'border-slate-700/50 text-slate-600'
                        }`}
                        title={r.url ?? r.error ?? ''}
                      >
                        r/{r.sub}{r.url ? ' ✓' : r.error ? ' ✗' : ''}
                      </span>
                    ))}
                    {p.twitter?.tweetId && (
                      <span className="text-[9px] font-mono px-1.5 py-0.5 rounded border border-green-900/50 text-green-400">
                        twitter ✓
                      </span>
                    )}
                    {p.hn?.submitUrl && (
                      <a href={p.hn.submitUrl} target="_blank" rel="noopener noreferrer"
                         className="text-[9px] font-mono px-1.5 py-0.5 rounded border border-amber-900/50 text-amber-400 hover:bg-amber-950/30">
                        → submit HN
                      </a>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Gumroad drafts ──────────────────────────────────────────────────── */}
      <div className="px-4 py-3">
        <div className="flex items-center justify-between mb-2">
          <div className="text-[10px] font-mono text-slate-500 tracking-[0.2em] uppercase">Gumroad Drafts</div>
          {unPublishedGumroad.length > 0 && (
            <span className="text-[9px] font-mono text-amber-400 animate-pulse">
              {unPublishedGumroad.length} awaiting you
            </span>
          )}
        </div>

        {gumroad.length === 0 ? (
          <div className="text-[11px] font-mono text-slate-600">God hasn&apos;t drafted any products yet</div>
        ) : (
          <div className="space-y-2">
            {unPublishedGumroad.map(p => (
              <div key={p.index} className="border border-amber-900/30 bg-amber-950/10 rounded p-3">
                <div className="flex items-center justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-bold text-amber-300">{p.name}</div>
                    <div className="text-[10px] text-slate-400 mt-0.5">{p.tagline}</div>
                    <div className="text-[9px] font-mono text-slate-600 mt-1">
                      ${p.price} · drafted {timeAgo(p.generatedAt)}
                    </div>
                  </div>
                  <button
                    onClick={() => setExpanded(expanded === p.index ? null : p.index)}
                    className="text-[10px] font-mono px-2 py-1 rounded border border-slate-700/50 text-slate-400 hover:bg-slate-800/30"
                  >
                    {expanded === p.index ? '↑ hide' : '↓ preview'}
                  </button>
                </div>

                {expanded === p.index && (
                  <div className="mt-3 space-y-2">
                    <div className="text-[10px] text-slate-400 whitespace-pre-wrap bg-black/40 border border-slate-800/40 rounded p-2 max-h-40 overflow-y-auto">
                      {p.description}
                    </div>
                    <div className="text-[10px] text-slate-500">
                      <strong>Included:</strong>
                      <ul className="mt-1 space-y-0.5">
                        {p.included.map((item, i) => <li key={i}>· {item}</li>)}
                      </ul>
                    </div>
                  </div>
                )}

                <div className="flex gap-2 mt-3">
                  <button
                    onClick={() => copyToClipboard(
                      `${p.name}\n\n${p.tagline}\n\n${p.description}\n\n— Included —\n${p.included.map(i => `• ${i}`).join('\n')}\n\nPrice: $${p.price}`,
                      `gr-${p.index}`,
                    )}
                    className="flex-1 text-[10px] font-mono px-2 py-1 rounded border border-cyan-900/50 text-cyan-400 hover:bg-cyan-950/30"
                  >
                    {copied === `gr-${p.index}` ? '✓ COPIED' : '📋 COPY LISTING'}
                  </button>
                  <a
                    href="https://app.gumroad.com/products/new"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 text-[10px] font-mono px-2 py-1 rounded border border-green-900/50 text-green-400 hover:bg-green-950/30 text-center"
                  >
                    → OPEN GUMROAD
                  </a>
                  <button
                    onClick={() => markPublished(p.index)}
                    className="flex-1 text-[10px] font-mono px-2 py-1 rounded border border-purple-900/50 text-purple-400 hover:bg-purple-950/30"
                  >
                    ✓ MARK PUBLISHED
                  </button>
                </div>
              </div>
            ))}

            {publishedGumroad.length > 0 && (
              <div className="pt-2 border-t border-slate-800/30">
                <div className="text-[9px] font-mono text-slate-600 mb-1">Live on Gumroad:</div>
                <div className="space-y-1">
                  {publishedGumroad.map(p => (
                    <a
                      key={p.index}
                      href={p.publishedUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block text-[11px] text-green-400 hover:text-green-300"
                    >
                      ✓ {p.name} — ${p.price} <span className="text-slate-600">· {p.publishedUrl}</span>
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
