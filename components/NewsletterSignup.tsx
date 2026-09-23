'use client'

import { useState } from 'react'

interface Props {
  /** Where on the site this widget was rendered — sent through to /api/subscribe */
  source?: string
  /** Optional pitch line override */
  pitch?: string
}

/**
 * Compact newsletter signup. Renders on every topic page — captures visitors
 * who won't drop $39 on the kit today but might convert later via email.
 * Posts to the existing /api/subscribe endpoint (which already handles
 * Supabase + JSON fallback + dedupe).
 */
export default function NewsletterSignup({ source = 'topic-page', pitch }: Props) {
  const [email, setEmail]   = useState('')
  const [state, setState]   = useState<'idle' | 'loading' | 'ok' | 'err'>('idle')
  const [error, setError]   = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (state === 'loading') return
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
      setError('please enter a valid email')
      setState('err')
      return
    }
    setState('loading')
    setError(null)
    try {
      const res = await fetch('/api/subscribe', {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({ email, source }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      setState('ok')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed')
      setState('err')
    }
  }

  if (state === 'ok') {
    return (
      <div className="my-8 rounded border border-emerald-700/50 bg-emerald-950/20 px-5 py-4">
        <div className="text-[11px] font-mono tracking-[0.25em] text-emerald-400 uppercase mb-1">✓ subscribed</div>
        <div className="text-[13px] text-slate-200">Thanks — you&apos;ll get the next dispatch when there&apos;s something worth sending.</div>
      </div>
    )
  }

  return (
    <form
      onSubmit={submit}
      className="my-8 rounded border border-slate-800/60 bg-slate-900/40 px-5 py-4"
    >
      <div className="text-[11px] font-mono tracking-[0.25em] text-cyan-400 uppercase mb-1">◇ no time to read?</div>
      <div className="text-[13px] text-slate-300 mb-3 leading-relaxed">
        {pitch ?? 'Get one tight email when I publish something worth sharing — autonomous AI agents, cost engineering, post-mortems. No spam, no SaaS pitches.'}
      </div>
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          type="email"
          value={email}
          onChange={e => { setEmail(e.target.value); if (state === 'err') { setState('idle'); setError(null) } }}
          placeholder="you@domain.com"
          className="flex-1 bg-black/40 border border-slate-700 rounded px-3 py-2 text-[13px] text-slate-200 placeholder:text-slate-600 outline-none focus:border-cyan-700"
          required
          disabled={state === 'loading'}
        />
        <button
          type="submit"
          disabled={state === 'loading'}
          className="px-4 py-2 rounded bg-cyan-700 hover:bg-cyan-600 text-white text-[12px] font-mono tracking-wider uppercase disabled:opacity-50"
        >
          {state === 'loading' ? 'sending…' : 'subscribe'}
        </button>
      </div>
      {error && <div className="text-[11px] font-mono text-red-400 mt-2">{error}</div>}
    </form>
  )
}
