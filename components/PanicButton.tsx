'use client'

import { useEffect, useState } from 'react'

interface ProcessInfo { name: string; status: string }
interface PanicStatus { configured: boolean; processes: ProcessInfo[] }

/**
 * "Pause everything" safety control. One click → asks for confirmation →
 * POSTs /api/panic, which triggers `pm2 stop all`. Authorised server-side by
 * the platform-admin session and recorded in audit_log. No secret is held in
 * the browser.
 */
export default function PanicButton() {
  const [status, setStatus]   = useState<PanicStatus | null>(null)
  const [working, setWorking] = useState(false)
  const [confirm, setConfirm] = useState(false)

  async function fetchStatus() {
    try {
      const r = await fetch('/api/panic', { cache: 'no-store' })
      if (r.ok) setStatus(await r.json())
    } catch {}
  }

  useEffect(() => {
    fetchStatus()
    const id = setInterval(fetchStatus, 15_000)
    return () => clearInterval(id)
  }, [])

  async function call(action: 'stop' | 'resume' | 'restart') {
    setWorking(true)
    try {
      const r = await fetch('/api/panic', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action }),
      })
      const body = await r.json().catch(() => null)
      if (!r.ok) {
        alert(`Action failed: ${body?.error ?? r.status}`)
      }
      await fetchStatus()
    } catch (e) {
      alert(`Network error: ${(e as Error).message}`)
    }
    setWorking(false)
    setConfirm(false)
  }

  const controlled = (status?.processes ?? []).filter(p =>
    ['god', 'ruflo-agents', 'ruflo-orchestrator', 'revenue', 'promote', 'god-dreams', 'god-poster', 'watchdog', 'jarvis-briefings'].includes(p.name)
  )
  const anyRunning = controlled.some(p => p.status === 'online')
  const allStopped = controlled.length > 0 && controlled.every(p => p.status === 'stopped')

  if (!status) return null

  return (
    <div className="rounded border border-red-900/40 bg-red-950/10 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-red-900/30 bg-black/40">
        <span className="text-xs font-mono tracking-[0.2em] text-red-500 uppercase">⛔ Emergency Controls</span>
        <span className="text-[10px] font-mono text-slate-600">{controlled.length} processes · {controlled.filter(p => p.status === 'online').length} online</span>
      </div>

      <div className="p-3">

        <div className="flex gap-2 flex-wrap">
          {anyRunning && !confirm && (
            <button
              onClick={() => setConfirm(true)}
              className="text-xs font-mono px-3 py-2 rounded border-2 border-red-700 bg-red-950/40 text-red-300 hover:bg-red-900/60 hover:border-red-500 transition-colors font-bold"
              disabled={working || !status.configured}
            >
              🛑 STOP ALL
            </button>
          )}

          {anyRunning && confirm && (
            <>
              <button
                onClick={() => call('stop')}
                className="text-xs font-mono px-3 py-2 rounded border-2 border-red-500 bg-red-900/60 text-red-200 hover:bg-red-800 font-bold animate-pulse"
                disabled={working}
              >
                {working ? '...' : '⚠ CONFIRM STOP'}
              </button>
              <button
                onClick={() => setConfirm(false)}
                className="text-xs font-mono px-3 py-2 rounded border border-slate-700 text-slate-400 hover:text-slate-200"
              >
                cancel
              </button>
            </>
          )}

          {allStopped && (
            <button
              onClick={() => call('resume')}
              className="text-xs font-mono px-3 py-2 rounded border-2 border-emerald-700 bg-emerald-950/40 text-emerald-300 hover:bg-emerald-900/60 font-bold"
              disabled={working || !status.configured}
            >
              ▶ RESUME ALL
            </button>
          )}

          <button
            onClick={() => call('restart')}
            className="text-xs font-mono px-3 py-2 rounded border border-slate-700 bg-slate-900/40 text-slate-300 hover:bg-slate-800/60"
            disabled={working || !status.configured}
          >
            ⟳ RESTART ALL
          </button>
        </div>

        {/* Process list */}
        <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-1.5">
          {controlled.map(p => (
            <div
              key={p.name}
              className={`text-[10px] font-mono px-2 py-1 rounded border flex items-center gap-1.5 ${
                p.status === 'online'  ? 'border-emerald-800/50 bg-emerald-950/20 text-emerald-300' :
                p.status === 'stopped' ? 'border-red-800/50     bg-red-950/20     text-red-300'     :
                                         'border-slate-700/50   bg-slate-900/40   text-slate-500'
              }`}
            >
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${
                p.status === 'online' ? 'bg-emerald-500' : 'bg-red-500'
              }`} />
              <span className="truncate">{p.name}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
