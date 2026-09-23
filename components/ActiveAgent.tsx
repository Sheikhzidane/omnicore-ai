'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { Todo } from '@/types/todos'

interface Trace {
  id: string
  tool_name: string
  input_summary: string | null
  is_error: boolean
  duration_ms: number | null
}

interface Props { todos: Todo[] }

const TOOL_ICONS: Record<string, string> = {
  read_file: '📄', write_file: '✏️', list_directory: '📁',
  run_sql: '🔍', run_ddl: '🔧', list_tables: '📋', describe_table: '🗂️',
  web_search: '🌐', fetch_url: '🔗', task_complete: '✅',
}

/** Stale threshold in milliseconds — tasks idle longer than this get flagged */
const STALE_MS = 5 * 60 * 1000   // 5 minutes
const WARN_MS  = 2 * 60 * 1000   // 2 minutes — amber caution zone

function LiveTimer({ since }: { since: string }) {
  const [elapsed, setElapsed] = useState('')
  useEffect(() => {
    function tick() {
      const ms = Date.now() - new Date(since).getTime()
      const s = Math.floor(ms / 1000)
      const m = Math.floor(s / 60)
      const h = Math.floor(m / 60)
      if (h > 0)      setElapsed(`${h}h${m % 60}m`)
      else if (m > 0) setElapsed(`${m}m${s % 60}s`)
      else            setElapsed(`${s}s`)
    }
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [since])
  return <>{elapsed}</>
}

/**
 * StaleBadge — amber/red pill that appears when a task has been `in_progress`
 * for a suspiciously long time without any update. Lets the operator spot hung
 * agents at a glance without digging into traces.
 */
function StaleBadge({ updatedAt }: { updatedAt: string }) {
  const [ageMs, setAgeMs] = useState(0)

  useEffect(() => {
    function tick() {
      setAgeMs(Date.now() - new Date(updatedAt).getTime())
    }
    tick()
    const t = setInterval(tick, 15_000)   // re-check every 15 s is plenty
    return () => clearInterval(t)
  }, [updatedAt])

  if (ageMs < WARN_MS) return null

  const isStale = ageMs >= STALE_MS
  return (
    <span
      className={`
        text-[9px] font-mono font-bold px-1.5 py-0.5 rounded border flex-shrink-0 tracking-wider
        ${isStale
          ? 'bg-red-950/50 border-red-700/50 text-red-300 animate-pulse'
          : 'bg-amber-950/40 border-amber-700/40 text-amber-400'
        }
      `}
      title={`Last update ${Math.round(ageMs / 60000)} min ago — agent may be hung`}
    >
      {isStale ? '⚠ STALE' : '· SLOW'}
    </span>
  )
}

function useLastTrace(taskId: string) {
  const [last, setLast] = useState<Trace | null>(null)
  const [count, setCount] = useState(0)

  useEffect(() => {
    const supabase = createClient()
    ;supabase.from('traces')
      .select('id,tool_name,input_summary,is_error,duration_ms')
      .eq('task_id', taskId)
      .order('created_at', { ascending: false })
      .limit(1)
      .then(({ data }) => {
        if (data?.[0]) setLast(data[0])
      })
    ;supabase.from('traces')
      .select('id', { count: 'exact', head: true })
      .eq('task_id', taskId)
      .then(({ count: c }) => setCount(c ?? 0))

    // Unique channel name so rapid task switches don't collide with the previous channel
    const ch = supabase.channel(`act-${taskId}-${Date.now()}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'traces', filter: `task_id=eq.${taskId}` },
        ({ new: row }) => { setLast(row as Trace); setCount(c => c + 1) }
      ).subscribe()
    return () => {
      ch.unsubscribe()
      supabase.removeChannel(ch)
    }
  }, [taskId])

  return { last, count }
}

function ActiveRow({ todo }: { todo: Todo }) {
  const { last, count } = useLastTrace(todo.id)
  const pool = todo.assigned_agent?.replace(/-[a-f0-9]{6}$/, '') ?? 'agent'

  const lastLabel = last ? (() => {
    try {
      const p = JSON.parse(last.input_summary ?? '{}')
      const detail = p.path ?? p.query?.slice(0, 40) ?? p.statement?.slice(0, 40) ?? ''
      return detail ? `${TOOL_ICONS[last.tool_name] ?? '⚡'} ${detail}` : `${TOOL_ICONS[last.tool_name] ?? '⚡'} ${last.tool_name}`
    } catch { return `${TOOL_ICONS[last.tool_name] ?? '⚡'} ${last.tool_name}` }
  })() : null

  return (
    <div className="flex items-center gap-3 px-3 py-2 min-w-0">
      {/* Pulse dot */}
      <span className="h-1.5 w-1.5 rounded-full bg-cyan-500 animate-pulse flex-shrink-0" />

      {/* Agent pool */}
      <span className="text-xs font-mono text-purple-400 flex-shrink-0 hidden sm:block w-28 truncate">
        {pool}
      </span>

      {/* Task title */}
      <span className="text-xs font-mono text-slate-300 truncate flex-1 min-w-0">
        {todo.title}
      </span>

      {/* Stale badge — shown when the task hasn't been updated recently */}
      <StaleBadge updatedAt={todo.updated_at} />

      {/* Last tool */}
      {lastLabel && (
        <span className="text-[11px] font-mono text-slate-600 truncate max-w-36 hidden md:block flex-shrink-0">
          {lastLabel}
        </span>
      )}

      {/* Call count */}
      {count > 0 && (
        <span className="text-[10px] font-mono text-slate-700 flex-shrink-0 tabular-nums">
          {count}×
        </span>
      )}

      {/* Elapsed timer — coloured by staleness */}
      <span className={`text-xs font-mono tabular-nums flex-shrink-0 ${
        Date.now() - new Date(todo.updated_at).getTime() >= STALE_MS
          ? 'text-red-400'
          : Date.now() - new Date(todo.updated_at).getTime() >= WARN_MS
            ? 'text-amber-400'
            : 'text-cyan-500'
      }`}>
        <LiveTimer since={todo.updated_at} />
      </span>
    </div>
  )
}

export default function ActiveAgent({ todos }: Props) {
  const active = todos.filter(t => t.status === 'in_progress')

  // Count stale tasks for the header summary
  const staleCount = active.filter(
    t => Date.now() - new Date(t.updated_at).getTime() >= STALE_MS
  ).length

  if (active.length === 0) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded border border-slate-800/40 bg-black/20">
        <span className="h-1.5 w-1.5 rounded-full bg-slate-800 flex-shrink-0" />
        <span className="text-xs font-mono text-slate-700 tracking-widest">QUEUE IDLE</span>
      </div>
    )
  }

  // Show up to 6 rows before scrolling (~192 px at 32 px/row).
  const MAX_VISIBLE = 6
  const visibleHeight = Math.min(active.length, MAX_VISIBLE) * 36

  return (
    <div className={`rounded border overflow-hidden ${
      staleCount > 0
        ? 'border-amber-900/50 bg-black/30'
        : 'border-cyan-900/30 bg-black/30'
    }`}>
      {/* Header */}
      <div className={`flex items-center gap-2 px-3 py-1.5 border-b bg-black/40 ${
        staleCount > 0 ? 'border-amber-900/30' : 'border-cyan-900/20'
      }`}>
        <span className="h-1.5 w-1.5 rounded-full bg-cyan-500 animate-pulse flex-shrink-0" />
        <span className="text-xs font-mono text-cyan-700 tracking-widest">RUNNING NOW</span>

        {/* Active count badge */}
        <span className="ml-1 text-[10px] font-mono bg-cyan-900/40 text-cyan-400 border border-cyan-700/40 rounded px-1.5 py-0.5 tabular-nums">
          {active.length}
        </span>

        {/* Stale count badge — draws attention when agents go dark */}
        {staleCount > 0 && (
          <span
            className="text-[10px] font-mono bg-amber-950/50 text-amber-300 border border-amber-700/50 rounded px-1.5 py-0.5 tabular-nums animate-pulse"
            title={`${staleCount} task${staleCount !== 1 ? 's' : ''} with no activity for ≥5 min — agents may be hung`}
          >
            ⚠ {staleCount} stale
          </span>
        )}

        {active.length > MAX_VISIBLE && (
          <span className="text-[10px] font-mono text-slate-700 ml-auto">
            scroll ↕ {active.length - MAX_VISIBLE} more
          </span>
        )}
      </div>

      {/* Scrollable rows — grows to fit up to MAX_VISIBLE, then scrolls */}
      <div
        className="overflow-y-auto divide-y divide-slate-800/40"
        style={{ maxHeight: `${MAX_VISIBLE * 36}px`, height: `${visibleHeight}px` }}
      >
        {active.map(todo => (
          <ActiveRow key={todo.id} todo={todo} />
        ))}
      </div>
    </div>
  )
}
