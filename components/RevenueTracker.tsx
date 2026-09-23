'use client'

import { useEffect, useState } from 'react'

interface Post {
  id: number
  title: string
  topicType: string
  publishedAt: string
  platform: string
  devToUrl: string | null
  published: boolean
  views: number
  reactions: number
  estimatedEarns: number
  tags: string[]
}

interface GumroadProduct {
  name: string
  tagline: string
  description: string
  included: string[]
  price: number
  generatedAt: string
}

interface RevenueLog {
  posts: Post[]
  totalEstimatedEarnings: number
  totalEstimatedViews: number
  gumroadProducts: GumroadProduct[]
  lastUpdated: string | null
}

function fmtSmall(n: number) {
  if (n < 0.001) return `$0.00`
  return `$${n.toFixed(4)}`
}
function fmtBig(n: number) { return `$${n.toFixed(2)}` }

export default function RevenueTracker() {
  const [data, setData]               = useState<RevenueLog | null>(null)
  const [costTotal, setCostTotal]     = useState(0)
  const [expanded, setExpanded]       = useState(false)
  const [showGumroad, setShowGumroad] = useState(false)

  useEffect(() => {
    async function load() {
      try {
        const [rev, cost] = await Promise.all([fetch('/api/revenue'), fetch('/api/cost')])
        if (rev.ok)  setData(await rev.json())
        if (cost.ok) { const c = await cost.json(); setCostTotal(c.total ?? 0) }
      } catch {}
    }
    load()
    const id = setInterval(load, 60_000)
    return () => clearInterval(id)
  }, [])

  if (!data) return null

  const posts     = data.posts ?? []
  const earnings  = data.totalEstimatedEarnings ?? 0
  const views     = data.totalEstimatedViews ?? 0
  const published = posts.filter(p => p.published).length
  const pending   = posts.filter(p => !p.published).length
  const product   = data.gumroadProducts?.[0] ?? null
  const netPnL    = earnings - costTotal
  const isProfit  = netPnL >= 0

  const lastPost    = posts.at(-1)
  const nextPostMin = lastPost
    ? Math.max(0, Math.round((8 * 60) - (Date.now() - new Date(lastPost.publishedAt).getTime()) / 60000))
    : 0

  return (
    <div className="rounded border border-green-900/30 bg-black/40 overflow-hidden">
      {/* Header / toggle */}
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between px-4 py-2 bg-black/60 hover:bg-black/80 border-b border-green-900/20 transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className="text-xs font-mono tracking-[0.2em] text-green-700 uppercase">◈ Revenue Engine</span>
          {published === 0 && posts.length === 0 && (
            <span className="text-[10px] font-mono text-yellow-700">⚠ needs setup</span>
          )}
          {published > 0 && (
            <span className="text-[10px] font-mono text-green-600">{published} article{published !== 1 ? 's' : ''} live</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className={`text-xs font-mono tabular-nums font-bold ${isProfit ? 'text-green-500' : 'text-yellow-600'}`}>
            {isProfit ? '+' : ''}{fmtBig(netPnL)}
            <span className="text-slate-700 font-normal"> net</span>
          </span>
          <span className="text-xs font-mono text-slate-700">{expanded ? '▲' : '▼'}</span>
        </div>
      </button>

      {expanded && (
        <div className="p-3 space-y-4">

          {/* P&L grid */}
          <div className="grid grid-cols-3 gap-2">
            {[
              { label: 'NET P&L',     value: fmtBig(netPnL),    color: isProfit ? 'text-green-500' : 'text-yellow-600' },
              { label: 'EARNED EST.', value: fmtBig(earnings),  color: 'text-green-600' },
              { label: 'API COST',    value: fmtBig(costTotal), color: 'text-red-600' },
            ].map(({ label, value, color }) => (
              <div key={label} className="rounded bg-black/40 border border-slate-800/40 p-2 text-center">
                <div className={`text-base font-mono font-bold tabular-nums ${color}`}>{value}</div>
                <div className="text-[10px] font-mono text-slate-600 mt-0.5">{label}</div>
              </div>
            ))}
          </div>

          {/* Stats row */}
          <div className="flex flex-wrap gap-4 text-xs font-mono">
            <span className="text-slate-500">{published} published</span>
            {pending > 0 && <span className="text-yellow-700">{pending} queued (no key)</span>}
            <span className="text-slate-500">{views.toLocaleString()} views</span>
            {nextPostMin > 0 && <span className="text-slate-700 ml-auto">next post ~{nextPostMin}m</span>}
          </div>

          {/* Setup prompt */}
          {posts.length === 0 && (
            <div className="rounded border border-yellow-900/30 bg-yellow-950/20 p-3 space-y-2">
              <div className="text-xs font-mono text-yellow-600 font-bold">ADD KEY → START EARNING</div>
              <ol className="text-[11px] font-mono text-slate-500 space-y-1 list-decimal list-inside">
                <li>Go to <span className="text-cyan-700">dev.to/settings/extensions</span> → &ldquo;New Key&rdquo;</li>
                <li>Add <span className="text-green-700">DEV_TO_API_KEY=your_key</span> to .env.local</li>
                <li>Run: <span className="text-green-700">pm2 restart revenue --update-env</span></li>
                <li>Articles auto-post every 8h, earning per 1,000 reads</li>
              </ol>
            </div>
          )}

          {/* Articles list */}
          {posts.length > 0 && (
            <div>
              <div className="text-xs font-mono text-slate-600 tracking-widest mb-1.5">ARTICLES</div>
              <div className="space-y-1.5">
                {posts.slice().reverse().slice(0, 6).map(p => (
                  <div key={p.id} className="flex items-start gap-2 text-xs font-mono">
                    <span className={`mt-0.5 shrink-0 ${p.published ? 'text-green-700' : 'text-yellow-700'}`}>
                      {p.published ? '●' : '○'}
                    </span>
                    <div className="flex-1 min-w-0">
                      {p.devToUrl ? (
                        <a href={p.devToUrl} target="_blank" rel="noopener noreferrer"
                           className="text-cyan-700 hover:text-cyan-500 truncate block">
                          {p.title}
                        </a>
                      ) : (
                        <span className="text-slate-500 truncate block">{p.title}</span>
                      )}
                      <div className="flex gap-3 text-[10px] text-slate-700 mt-0.5">
                        <span>{new Date(p.publishedAt).toLocaleDateString()}</span>
                        {p.views > 0 && <span>{p.views.toLocaleString()} views</span>}
                        {p.reactions > 0 && <span>{p.reactions} ❤</span>}
                        <span className="text-green-800 ml-auto">{fmtSmall(p.estimatedEarns)}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Gumroad product */}
          {product && (
            <div>
              <button
                onClick={() => setShowGumroad(g => !g)}
                className="text-xs font-mono text-purple-600 hover:text-purple-400 tracking-widest"
              >
                ◈ GUMROAD LISTING {showGumroad ? '▲' : '▼'}
              </button>
              {showGumroad && (
                <div className="mt-2 rounded border border-purple-900/30 bg-purple-950/10 p-3 space-y-2">
                  <div className="text-sm font-mono text-purple-400 font-bold">{product.name}</div>
                  <div className="text-xs font-mono text-slate-500 italic">{product.tagline}</div>
                  <div className="text-[11px] font-mono text-slate-600 leading-relaxed">{product.description}</div>
                  <div className="space-y-0.5">
                    {product.included.map((item, i) => (
                      <div key={i} className="text-[11px] font-mono text-slate-600">✓ {item}</div>
                    ))}
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-mono text-green-500 font-bold">${product.price}</span>
                    <span className="text-[10px] font-mono text-purple-800">→ gumroad.com/products/new</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* How it works */}
          <div className="border-t border-slate-800/40 pt-2 space-y-0.5">
            <div className="text-[10px] font-mono text-slate-700">◈ Publishes 1 technical article/8h to dev.to Partner Program (~$0.80/1k reads)</div>
            <div className="text-[10px] font-mono text-slate-700">◈ Cross-post to Medium for 2–4× more from member reads</div>
            <div className="text-[10px] font-mono text-slate-700">◈ Gumroad listing above → sell the starter kit for $29–$49</div>
          </div>
        </div>
      )}
    </div>
  )
}
