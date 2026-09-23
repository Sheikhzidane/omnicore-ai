'use client'

import { useEffect, useState } from 'react'

export default function NewsletterComposer() {
  const [subject, setSubject] = useState('')
  const [html, setHtml]       = useState('')
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [from, setFrom]       = useState<string>('')
  const [state, setState]     = useState<'idle' | 'sending' | 'done' | 'error'>('idle')
  const [msg, setMsg]         = useState<string>('')
  const [subscriberCount, setSubscriberCount] = useState<number | null>(null)

  useEffect(() => {
    fetch('/api/newsletter/send')
      .then(r => r.json() as Promise<{ configured: boolean; from: string }>)
      .then(j => { setConfigured(j.configured); setFrom(j.from) })
      .catch(() => {})
    fetch('/api/subscribe')
      .then(r => r.json() as Promise<{ total: number }>)
      .then(j => setSubscriberCount(j.total))
      .catch(() => {})
  }, [])

  async function send(mode: 'self-test' | 'preview' | 'broadcast') {
    if (!subject.trim() || !html.trim()) {
      setMsg('Subject and content are both required')
      setState('error')
      return
    }
    if (mode === 'broadcast' && !confirm(`Send "${subject}" to ALL ${subscriberCount ?? '?'} subscribers? This can't be undone.`)) return

    setState('sending')
    setMsg('')
    try {
      const r = await fetch('/api/newsletter/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subject: subject.trim(),
          html:    html.trim(),
          toSelfOnly: mode === 'self-test',
          preview:    mode === 'preview',
        }),
      })
      const j = await r.json() as { ok?: boolean; error?: string; sent?: number; wouldSendTo?: number; sample?: string[]; mode?: string; sentTo?: string[] }
      if (!r.ok || j.error) {
        setState('error')
        setMsg(j.error ?? 'Send failed')
        return
      }
      setState('done')
      if (j.mode === 'self-test') setMsg(`✓ Self-test sent to ${j.sentTo?.[0] ?? '?'}`)
      else if (j.mode === 'preview') setMsg(`Preview — would send to ${j.wouldSendTo} subs. Sample: ${j.sample?.slice(0, 3).join(', ')}…`)
      else setMsg(`✓ Sent to ${j.sent} subscribers`)
    } catch (e) {
      setState('error')
      setMsg(e instanceof Error ? e.message : 'Network error')
    } finally {
      setTimeout(() => setState('idle'), 6000)
    }
  }

  if (configured === false) {
    return (
      <div className="rounded border border-amber-900/40 bg-amber-950/20 px-4 py-3">
        <div className="text-xs font-mono text-amber-400 font-bold">◈ Newsletter</div>
        <div className="text-[11px] font-mono text-slate-400 mt-1">
          Set <span className="text-slate-300">RESEND_API_KEY</span> in <span className="text-slate-300">.env.local</span> to send newsletters.
        </div>
        <div className="text-[10px] font-mono text-slate-500 mt-2">
          Get a free key (3,000 emails/mo) at <a className="text-cyan-400" href="https://resend.com/api-keys" target="_blank" rel="noopener noreferrer">resend.com/api-keys</a>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded border border-slate-800/60 bg-black/40 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800/60 bg-black/60">
        <div className="flex items-center gap-3">
          <span className="text-xs font-mono tracking-[0.2em] text-slate-500 uppercase">◈ Newsletter</span>
          <span className="text-[10px] font-mono text-slate-500">
            {subscriberCount !== null ? `${subscriberCount} recipients` : '— recipients'}
          </span>
          <span className="text-[9px] font-mono text-slate-700">from: {from}</span>
        </div>
      </div>

      <div className="p-3 space-y-3">
        <input
          value={subject}
          onChange={e => setSubject(e.target.value)}
          placeholder="Subject line…"
          className="w-full bg-slate-950 border border-slate-800/60 rounded px-3 py-2 text-sm font-mono text-slate-200 placeholder-slate-600 outline-none focus:border-cyan-800/50"
        />
        <textarea
          value={html}
          onChange={e => setHtml(e.target.value)}
          placeholder="<h2>Hey subscribers,</h2><p>Something cool shipped...</p>"
          rows={10}
          className="w-full bg-slate-950 border border-slate-800/60 rounded px-3 py-2 text-xs font-mono text-slate-200 placeholder-slate-600 outline-none focus:border-cyan-800/50 resize-y"
        />

        {msg && (
          <div className={`text-[10px] font-mono ${
            state === 'error' ? 'text-red-400' : state === 'done' ? 'text-green-400' : 'text-slate-400'
          }`}>
            {msg}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => send('self-test')}
            disabled={state === 'sending'}
            className="text-[10px] font-mono px-3 py-1.5 rounded border border-cyan-900/50 text-cyan-400 hover:bg-cyan-950/30 disabled:opacity-40"
            title="Send only to your test email first"
          >
            {state === 'sending' ? '… sending' : '🧪 SEND SELF-TEST'}
          </button>
          <button
            onClick={() => send('preview')}
            disabled={state === 'sending'}
            className="text-[10px] font-mono px-3 py-1.5 rounded border border-slate-700/50 text-slate-400 hover:bg-slate-800/30 disabled:opacity-40"
            title="Show who would receive without actually sending"
          >
            👁 PREVIEW RECIPIENTS
          </button>
          <button
            onClick={() => send('broadcast')}
            disabled={state === 'sending' || !subscriberCount}
            className="text-[10px] font-mono px-3 py-1.5 rounded border border-amber-900/60 bg-amber-950/20 text-amber-400 hover:bg-amber-950/40 disabled:opacity-40 ml-auto"
            title="Send to every subscriber — irreversible"
          >
            📢 BROADCAST TO ALL
          </button>
        </div>

        <div className="text-[9px] font-mono text-slate-700">
          Tip: always self-test first. Broadcast goes via BCC (recipients can&apos;t see each other).
        </div>
      </div>
    </div>
  )
}
