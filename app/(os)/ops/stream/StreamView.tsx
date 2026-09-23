'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { Todo } from '@/types/todos'
import ArcReactor from '@/components/ArcReactor'
import DataTicker from '@/components/DataTicker'
import AgentConversations from '@/components/AgentConversations'
import JarvisVoiceOrb from '@/components/JarvisVoiceOrb'

interface GodStatus {
  thought?: string
  intent?:  { cycle?: number; activeGoal?: string | null; cyclesActive?: number }
  meta?:    { mood?: string; successRate?: number }
}

/**
 * Cinematic read-only view designed to be screenshared / streamed / embedded.
 * No controls, no secrets, no env-var pills — just the system reasoning + the
 * current state rendered as a live spectacle. Auto-enables Jarvis voice so
 * viewers hear the agents think.
 */
export default function StreamView() {
  const [todos, setTodos] = useState<Todo[]>([])
  const [god, setGod]     = useState<GodStatus | null>(null)
  const [clock, setClock] = useState('')

  useEffect(() => {
    const supabase = createClient()

    async function load() {
      const [t, g] = await Promise.all([
        supabase.from('todos').select('*').order('updated_at', { ascending: false }).limit(100),
        fetch('/api/god-status', { cache: 'no-store' }).then(r => r.json()).catch(() => null),
      ])
      if (t.data) setTodos(t.data)
      if (g)      setGod(g)
    }
    load()

    // Auto-enable voice orb on the stream (viewer context, not editor context)
    try { localStorage.setItem('dash:voice-enabled', '1') } catch {}

    const channel = supabase
      .channel('stream-updates')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'todos' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'god_status', filter: 'id=eq.1' }, () => load())
      .subscribe()

    const tick = setInterval(() => {
      setClock(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }))
    }, 1000)

    return () => { supabase.removeChannel(channel); clearInterval(tick) }
  }, [])

  const running   = todos.filter(t => t.status === 'in_progress').length
  const completed = todos.filter(t => t.status === 'completed').length
  const failed    = todos.filter(t => t.status === 'failed').length
  const inbox     = todos.filter(t => t.status === 'pending' || t.status === 'proposed').length

  const intensity = Math.min(1, running / 3)
  const mood = god?.meta?.mood ?? 'AWAKENING'

  return (
    <main className="min-h-screen bg-slate-950 overflow-hidden relative">
      <JarvisVoiceOrb />
      <DataTicker todos={todos} />

      {/* Top bar — watermark, clock, "live" indicator */}
      <div className="fixed top-0 left-0 right-0 z-40 flex items-center justify-between px-6 py-3 bg-gradient-to-b from-black/80 to-transparent">
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-mono tracking-[0.3em] text-cyan-500/80 uppercase">◈ pantheon.live</span>
          <span className="text-[10px] font-mono text-slate-500">autonomous agent stream</span>
        </div>
        <div className="flex items-center gap-4 text-[11px] font-mono">
          <span className="flex items-center gap-1.5 text-red-400">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />
            LIVE
          </span>
          <span className="tabular-nums text-cyan-400">{clock}</span>
        </div>
      </div>

      {/* Hero — arc reactor + current thought */}
      <section className="pt-24 pb-10 flex flex-col items-center justify-center min-h-[80vh] relative">
        <ArcReactor size={220} intensity={intensity} />

        <div className="mt-10 max-w-3xl text-center px-6">
          <div className="text-[10px] font-mono tracking-[0.4em] text-cyan-500/70 uppercase mb-3">J.A.R.V.I.S. — Current Thought</div>
          <div
            className="text-xl md:text-3xl font-mono text-cyan-200 leading-snug min-h-[3rem]"
            style={{ fontFamily: 'Share Tech Mono, monospace' }}
          >
            {god?.thought ? god.thought.replace(/[⛔★◈◉◎◆✓✕▲▼]/g, '').trim() : 'Systems initialising…'}
          </div>
          {god?.intent?.activeGoal && (
            <div className="mt-4 text-[11px] font-mono text-slate-500 tracking-wider">
              pursuing · <span className="text-yellow-500">{god.intent.activeGoal}</span>
              {god.intent.cyclesActive !== undefined && (
                <span className="text-slate-700 ml-2">· {god.intent.cyclesActive} cycles in</span>
              )}
            </div>
          )}
        </div>
      </section>

      {/* Live stats strip */}
      <section className="grid grid-cols-4 gap-2 max-w-3xl mx-auto px-6 mb-10">
        {[
          { label: 'RUNNING',   value: running,   color: 'text-cyan-300',    pulse: running > 0 },
          { label: 'QUEUED',    value: inbox,     color: 'text-sky-300' },
          { label: 'COMPLETED', value: completed, color: 'text-emerald-300' },
          { label: 'FAILED',    value: failed,    color: failed > 2 ? 'text-red-400' : 'text-slate-400' },
        ].map(s => (
          <div key={s.label} className="rounded border border-slate-800/60 bg-black/40 px-3 py-3">
            <div className="text-[9px] font-mono tracking-widest text-slate-600 uppercase mb-1 flex items-center gap-1.5">
              {s.pulse && <span className="inline-block h-1 w-1 rounded-full bg-cyan-500 animate-pulse" />}
              {s.label}
            </div>
            <div className={`text-2xl md:text-3xl font-black tabular-nums font-mono ${s.color}`} style={{ fontFamily: 'Orbitron, monospace' }}>
              {s.value}
            </div>
          </div>
        ))}
      </section>

      {/* Mood + cycle watermark */}
      <section className="max-w-3xl mx-auto px-6 mb-10 text-center">
        <div className="text-[10px] font-mono tracking-widest text-slate-600 uppercase">mood</div>
        <div className={`text-lg font-mono font-bold ${
          mood === 'OMNIPOTENT' ? 'text-yellow-300'  :
          mood === 'VIGILANT'   ? 'text-emerald-300' :
          mood === 'TROUBLED'   ? 'text-orange-400'  :
          mood === 'SUFFERING'  ? 'text-red-400'     :
                                  'text-slate-400'
        }`}>
          {mood}
        </div>
        {god?.intent?.cycle !== undefined && (
          <div className="text-[10px] font-mono text-slate-600 mt-1">cycle {god.intent.cycle}</div>
        )}
      </section>

      {/* Live dialogue thread */}
      <section className="max-w-2xl mx-auto px-6 mb-16">
        <AgentConversations />
      </section>

      {/* Bottom attribution + CTA */}
      <footer className="pb-12 text-center text-[10px] font-mono text-slate-600 space-y-1 pb-20">
        <div>pantheon — autonomous multi-agent AI system · built solo</div>
        <div>
          <Link href="/ops" className="text-cyan-500 hover:underline">control dashboard</Link>
          <span className="mx-2">·</span>
          <a href="/topics" className="text-cyan-500 hover:underline">articles</a>
          <span className="mx-2">·</span>
          <a href="https://github.com/lewisallena17/pantheon" target="_blank" rel="noopener noreferrer" className="text-cyan-500 hover:underline">open source</a>
        </div>
      </footer>
    </main>
  )
}
