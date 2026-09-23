'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { Todo } from '@/types/todos'

interface CategoryStat { succeeded: number; failed: number }

interface GodMeta {
  mood: string
  moodColor: string
  moodIcon: string
  confidence: number
  cycles: number
  lessons: number
  activeGoals: string[]
  successRate: number
  agentsTracked: number
  categoryStats?: Record<string, CategoryStat>
  decisionHistory?: DecisionHistoryEntry[]
}

interface DecisionHistoryEntry {
  cycle: number
  at: string
  tasks: { title: string; priority: string; category: string }[]
  mode: 'council' | 'safe'
  successRate: number
  mood: string
}

interface GodIntent {
  activeGoal: string | null
  cyclesActive?: number
  cycle: number
  decreedTasks: { title: string; priority: string }[]
  reasoning: string
  nextCycleIn: string
  updatedAt: string
}

interface Props { todos: Todo[] }

const MOOD_COLORS: Record<string, string> = {
  yellow: 'text-yellow-400',
  green:  'text-green-400',
  orange: 'text-orange-400',
  red:    'text-red-400',
  cyan:   'text-cyan-400',
}

export default function GodView({ todos }: Props) {
  const canvasRef   = useRef<HTMLCanvasElement>(null)
  const frameRef    = useRef<number>(0)
  const phaseRef    = useRef(0)
  const [thought, setThought]       = useState('Watching...')
  const [isActive, setIsActive]     = useState(false)
  const [meta, setMeta]             = useState<GodMeta | null>(null)
  const [intent, setIntent]         = useState<GodIntent | null>(null)
  const [showHistory, setShowHistory] = useState(false)

  // Subscribe to god_status table for live thought + meta + intent updates
  useEffect(() => {
    const supabase = createClient()

    ;supabase.from('god_status').select('*').eq('id', 1).single().then(({ data }) => {
      // meta/intent are free-form jsonb written by the god agent
      if (data?.thought) setThought(data.thought)
      if (data?.meta)    setMeta(data.meta as unknown as GodMeta)
      if (data?.intent)  setIntent(data.intent as unknown as GodIntent)
    })

    // Unique channel name per mount so hot-reload + tab navigation don't
    // leave orphaned channels behind
    const channel = supabase
      .channel(`god-watch-${Date.now()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'god_status' }, ({ new: row }) => {
        if (row && 'thought' in row) {
          setThought(row.thought as string)
          setIsActive(true)
          setTimeout(() => setIsActive(false), 3000)
        }
        if (row && 'meta' in row && row.meta)     setMeta(row.meta as GodMeta)
        if (row && 'intent' in row && row.intent) setIntent(row.intent as GodIntent)
      })
      .subscribe()
    return () => {
      channel.unsubscribe()
      supabase.removeChannel(channel)
    }
  }, [])

  // Divine eye canvas
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const W = canvas.width
    const H = canvas.height
    const cx = W / 2
    const cy = H / 2

    const completed = todos.filter(t => t.status === 'completed').length
    const total     = Math.max(1, todos.length)
    const power     = completed / total

    function draw() {
      phaseRef.current += 0.02
      const p = phaseRef.current
      ctx.clearRect(0, 0, W, H)

      // Outer glow rings
      for (let r = 3; r >= 1; r--) {
        const radius = 38 + r * 10 + Math.sin(p * 0.7 + r) * 3
        const alpha  = (0.04 + power * 0.06) / r
        ctx.beginPath()
        ctx.arc(cx, cy, radius, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(255,215,0,${alpha})`
        ctx.lineWidth = 8
        ctx.stroke()
      }

      // Rotating halo rays
      const rayCount = 12
      for (let i = 0; i < rayCount; i++) {
        const angle  = (i / rayCount) * Math.PI * 2 + p * 0.3
        const inner  = 44
        const outer  = 52 + Math.sin(p * 2 + i) * 4
        const alpha  = 0.15 + power * 0.3 + Math.sin(p + i) * 0.05
        ctx.beginPath()
        ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner)
        ctx.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer)
        ctx.strokeStyle = `rgba(255,215,0,${alpha})`
        ctx.lineWidth = 1.5
        ctx.stroke()
      }

      // Eye white / iris background
      ctx.beginPath()
      ctx.ellipse(cx, cy, 32, 20, 0, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(10,8,2,0.95)'
      ctx.fill()
      ctx.strokeStyle = `rgba(255,215,0,${0.4 + power * 0.4})`
      ctx.lineWidth = 1.5
      ctx.stroke()

      // Iris
      const irisR = 14 + Math.sin(p * 0.5) * 1
      const irisGrad = ctx.createRadialGradient(cx, cy, 2, cx, cy, irisR)
      irisGrad.addColorStop(0, `rgba(255,180,0,${0.6 + power * 0.3})`)
      irisGrad.addColorStop(0.5, `rgba(180,90,0,${0.5 + power * 0.3})`)
      irisGrad.addColorStop(1, `rgba(80,40,0,0.3)`)
      ctx.beginPath()
      ctx.arc(cx, cy, irisR, 0, Math.PI * 2)
      ctx.fillStyle = irisGrad
      ctx.fill()

      // Pupil — vertical slit
      ctx.beginPath()
      ctx.ellipse(cx, cy, 3 + Math.sin(p * 0.3) * 0.5, 10, 0, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(0,0,0,0.95)'
      ctx.fill()

      // Pupil glow
      ctx.beginPath()
      ctx.arc(cx, cy, 5, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(255,220,50,${0.1 + power * 0.15 + Math.sin(p * 3) * 0.05})`
      ctx.fill()

      // Highlight
      ctx.beginPath()
      ctx.ellipse(cx - 6, cy - 5, 4, 2.5, -0.5, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(255,255,255,0.18)'
      ctx.fill()

      // Upper eyelid
      ctx.beginPath()
      ctx.moveTo(cx - 32, cy)
      ctx.quadraticCurveTo(cx, cy - 22, cx + 32, cy)
      ctx.strokeStyle = `rgba(255,200,0,${0.5 + power * 0.3})`
      ctx.lineWidth = 1.5
      ctx.stroke()

      // Lower eyelid
      ctx.beginPath()
      ctx.moveTo(cx - 32, cy)
      ctx.quadraticCurveTo(cx, cy + 16, cx + 32, cy)
      ctx.strokeStyle = `rgba(255,200,0,${0.4 + power * 0.2})`
      ctx.lineWidth = 1
      ctx.stroke()

      frameRef.current = requestAnimationFrame(draw)
    }

    frameRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frameRef.current)
  }, [todos])

  const completedCount = useMemo(() => todos.filter(t => t.status === 'completed').length, [todos])
  const activeCount    = useMemo(() => todos.filter(t => t.status === 'in_progress').length, [todos])
  const moodColorClass = MOOD_COLORS[meta?.moodColor ?? 'yellow'] ?? 'text-yellow-400'

  return (
    <div
      className="rounded border bg-black/60 overflow-hidden relative"
      style={{
        borderColor: isActive ? 'rgba(255,215,0,0.6)' : 'rgba(255,215,0,0.2)',
        boxShadow: isActive
          ? '0 0 40px rgba(255,215,0,0.2), 0 0 80px rgba(255,215,0,0.05)'
          : '0 0 20px rgba(255,215,0,0.05)',
        transition: 'all 0.5s ease',
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-yellow-500/20 bg-black/80">
        <span className="text-yellow-400 text-xs font-mono tracking-[0.3em] font-bold">◈ GOD</span>
        {meta && (
          <span className={`text-xs font-mono font-bold tracking-widest ${moodColorClass}`}>
            {meta.moodIcon} {meta.mood}
          </span>
        )}
        <div className="flex-1 h-px bg-yellow-900/30" />
        {meta && (
          <span className="text-xs font-mono text-yellow-800">
            cycle {meta.cycles} · {meta.lessons} lessons
          </span>
        )}
        {isActive && <span className="h-1.5 w-1.5 rounded-full bg-yellow-400 animate-pulse" />}
      </div>

      <div className="flex items-stretch gap-0 divide-x divide-yellow-900/20">

        {/* Eye canvas */}
        <div className="flex items-center justify-center p-4 bg-black/40" style={{ minWidth: 140 }}>
          <canvas ref={canvasRef} width={120} height={120} />
        </div>

        {/* Stats + thought */}
        <div className="flex-1 p-4 space-y-3">

          {/* Thought bubble */}
          <div
            className="rounded border border-yellow-900/40 bg-yellow-950/10 px-3 py-2"
            style={{ minHeight: 44 }}
          >
            <div className="text-xs font-mono text-yellow-700 tracking-widest mb-1">DIVINE THOUGHT</div>
            <div className={`text-xs font-mono ${isActive ? 'text-yellow-300' : 'text-yellow-600'} transition-colors duration-500`}>
              {thought}
              {isActive && <span className="blink ml-1">_</span>}
            </div>
          </div>

          {/* Confidence bar + stats */}
          {meta ? (
            <div className="space-y-2">
              {/* Confidence bar */}
              <div>
                <div className="flex justify-between text-xs font-mono text-yellow-900 mb-1">
                  <span>CONFIDENCE</span>
                  <span className={moodColorClass}>{meta.confidence}%</span>
                </div>
                <div className="h-1 bg-yellow-950/60 rounded overflow-hidden">
                  <div
                    className={`h-full rounded transition-all duration-1000 ${
                      meta.confidence >= 80 ? 'bg-yellow-400' :
                      meta.confidence >= 55 ? 'bg-green-500' :
                      meta.confidence >= 35 ? 'bg-orange-500' : 'bg-red-600'
                    }`}
                    style={{ width: `${meta.confidence}%` }}
                  />
                </div>
              </div>
              {/* Stats row */}
              <div className="flex gap-4 font-mono text-xs">
                <div className="text-center">
                  <div className="text-yellow-400 font-bold text-base">{todos.length}</div>
                  <div className="text-yellow-900 tracking-widest text-[10px]">TOTAL</div>
                </div>
                <div className="text-center">
                  <div className="text-green-400 font-bold text-base">{completedCount}</div>
                  <div className="text-yellow-900 tracking-widest text-[10px]">DONE</div>
                </div>
                <div className="text-center">
                  <div className="text-cyan-400 font-bold text-base">{activeCount}</div>
                  <div className="text-yellow-900 tracking-widest text-[10px]">ACTIVE</div>
                </div>
                <div className="text-center">
                  <div className="text-purple-400 font-bold text-base">{meta.agentsTracked}</div>
                  <div className="text-yellow-900 tracking-widest text-[10px]">AGENTS</div>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex gap-4 font-mono text-xs">
              <div className="text-center">
                <div className="text-yellow-400 font-bold text-lg">{todos.length}</div>
                <div className="text-yellow-900 tracking-widest">TOTAL</div>
              </div>
              <div className="text-center">
                <div className="text-green-400 font-bold text-lg">{completedCount}</div>
                <div className="text-yellow-900 tracking-widest">DONE</div>
              </div>
              <div className="text-center">
                <div className="text-cyan-400 font-bold text-lg">{activeCount}</div>
                <div className="text-yellow-900 tracking-widest">ACTIVE</div>
              </div>
            </div>
          )}
        </div>

        {/* Active goals */}
        <div className="p-3 space-y-1" style={{ minWidth: 200 }}>
          <div className="text-xs font-mono text-yellow-900 tracking-widest mb-2">ACTIVE GOALS</div>
          {meta?.activeGoals?.length ? (
            meta.activeGoals.slice(0, 4).map((g, i) => (
              <div key={i} className="text-xs font-mono text-yellow-800 truncate flex items-center gap-1.5">
                <span className="text-yellow-600 flex-shrink-0">▶</span>
                <span className="truncate">{g}</span>
              </div>
            ))
          ) : (
            todos
              .filter(t => t.status === 'pending')
              .slice(0, 4)
              .map(t => (
                <div key={t.id} className="text-xs font-mono text-yellow-800 truncate flex items-center gap-1.5">
                  <span className="text-yellow-600 flex-shrink-0">◈</span>
                  <span className="truncate">{t.title}</span>
                </div>
              ))
          )}
          {!meta?.activeGoals?.length && todos.filter(t => t.status === 'pending').length === 0 && (
            <div className="text-xs font-mono text-yellow-950 italic">All quiet.</div>
          )}
        </div>
      </div>

      {/* Alert: low success rate */}
      {meta && meta.successRate < 25 && meta.confidence > 0 && (
        <div className="border-t border-red-900/40 bg-red-950/20 px-4 py-2 flex items-center gap-2">
          <span className="text-red-500 text-xs font-mono animate-pulse">⚠</span>
          <span className="text-xs font-mono text-red-400 font-semibold tracking-wide">
            LOW SUCCESS RATE: {meta.successRate}% — God in safe mode, using proven task templates
          </span>
        </div>
      )}

      {/* Category breakdown + decision history toggle */}
      {meta && (meta.categoryStats || meta.decisionHistory?.length) && (
        <div className="border-t border-yellow-900/20">
          {/* Category success rates */}
          {meta.categoryStats && Object.keys(meta.categoryStats).length > 0 && (
            <div className="px-4 py-2 flex items-center gap-3 flex-wrap">
              <span className="text-[10px] font-mono text-yellow-900 tracking-widest flex-shrink-0">CATEGORIES</span>
              {Object.entries(meta.categoryStats).map(([cat, s]) => {
                const total = s.succeeded + s.failed
                if (total === 0) return null
                const rate = Math.round(s.succeeded / total * 100)
                return (
                  <div key={cat} className="flex items-center gap-1">
                    <span className="text-[9px] font-mono text-yellow-900 uppercase">{cat}</span>
                    <div className="w-10 h-1 bg-yellow-950/60 rounded overflow-hidden">
                      <div
                        className={`h-full rounded ${rate >= 70 ? 'bg-emerald-600' : rate >= 40 ? 'bg-yellow-600' : 'bg-red-700'}`}
                        style={{ width: `${rate}%` }}
                      />
                    </div>
                    <span className={`text-[9px] font-mono tabular-nums ${rate >= 70 ? 'text-emerald-600' : rate >= 40 ? 'text-yellow-700' : 'text-red-600'}`}>
                      {rate}%
                    </span>
                  </div>
                )
              })}
              {meta.decisionHistory && meta.decisionHistory.length > 0 && (
                <button
                  onClick={() => setShowHistory(h => !h)}
                  className="ml-auto text-[10px] font-mono text-yellow-900 hover:text-yellow-600 transition-colors tracking-widest"
                >
                  {showHistory ? '▲ HISTORY' : '▼ HISTORY'}
                </button>
              )}
            </div>
          )}

          {/* Decision history */}
          {showHistory && meta.decisionHistory && meta.decisionHistory.length > 0 && (
            <div className="border-t border-yellow-900/10 max-h-48 overflow-y-auto">
              {[...meta.decisionHistory].reverse().map((entry, i) => (
                <div key={i} className="px-4 py-2 border-b border-yellow-900/10 hover:bg-yellow-950/10">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px] font-mono text-yellow-800">Cycle {entry.cycle}</span>
                    <span className={`text-[9px] font-mono px-1 rounded border ${
                      entry.mode === 'safe'
                        ? 'text-orange-700 border-orange-900/40'
                        : 'text-yellow-800 border-yellow-900/30'
                    }`}>{entry.mode === 'safe' ? 'SAFE MODE' : 'COUNCIL'}</span>
                    <span className="text-[9px] font-mono text-yellow-900">{entry.successRate}% success</span>
                    <span className="text-[9px] font-mono text-yellow-900 ml-auto">
                      {new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  <div className="space-y-0.5">
                    {entry.tasks.slice(0, 3).map((t, j) => (
                      <div key={j} className="flex items-center gap-1.5">
                        <span className={`text-[9px] font-mono flex-shrink-0 ${
                          t.priority === 'critical' ? 'text-red-700' :
                          t.priority === 'high'     ? 'text-orange-700' : 'text-yellow-900'
                        }`}>[{t.priority?.slice(0,3).toUpperCase()}]</span>
                        <span className="text-[10px] font-mono text-yellow-900 truncate">{t.title}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Intent panel */}
      {intent && (
        <div className="border-t border-yellow-900/20 px-4 py-3 bg-black/20">
          <div className="flex items-start gap-4 flex-wrap">

            {/* Active goal */}
            <div className="flex-1 min-w-48">
              <div className="text-[10px] font-mono text-yellow-900 tracking-widest mb-1 flex items-center gap-2">
                CURRENT OBJECTIVE
                {intent.cyclesActive !== undefined && intent.cyclesActive > 0 && (
                  <span className={`text-[9px] px-1.5 py-0.5 rounded border tabular-nums ${
                    intent.cyclesActive >= 15
                      ? 'border-red-700/60    bg-red-950/30    text-red-300 animate-pulse'
                      : intent.cyclesActive >= 10
                      ? 'border-amber-700/60  bg-amber-950/30  text-amber-300'
                      : 'border-yellow-900/40 bg-yellow-950/20 text-yellow-600'
                  }`}>
                    {intent.cyclesActive}c active{intent.cyclesActive >= 15 ? ' · STALE' : ''}
                  </span>
                )}
              </div>
              {intent.activeGoal ? (
                <div className="text-xs font-mono text-yellow-500 font-semibold leading-snug">
                  {intent.activeGoal}
                </div>
              ) : (
                <div className="text-xs font-mono text-yellow-900 italic">No active roadmap goal</div>
              )}
            </div>

            {/* Reasoning */}
            <div className="flex-1 min-w-48">
              <div className="text-[10px] font-mono text-yellow-900 tracking-widest mb-1">COUNCIL REASONING</div>
              <div className="text-xs font-mono text-yellow-800 leading-snug">{intent.reasoning}</div>
            </div>

            {/* Latest decrees */}
            <div className="flex-1 min-w-48">
              <div className="text-[10px] font-mono text-yellow-900 tracking-widest mb-1">
                LAST DECREED <span className="text-yellow-950">(cycle {intent.cycle})</span>
              </div>
              <div className="space-y-0.5">
                {intent.decreedTasks.slice(0, 4).map((t, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <span className={`text-[10px] font-mono flex-shrink-0 ${
                      t.priority === 'critical' ? 'text-red-500' :
                      t.priority === 'high'     ? 'text-orange-500' :
                      t.priority === 'medium'   ? 'text-yellow-700' : 'text-slate-600'
                    }`}>[{t.priority.slice(0,3).toUpperCase()}]</span>
                    <span className="text-xs font-mono text-yellow-800 truncate">{t.title}</span>
                  </div>
                ))}
              </div>
            </div>

          </div>
        </div>
      )}
    </div>
  )
}
