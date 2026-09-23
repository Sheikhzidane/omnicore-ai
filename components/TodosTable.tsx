'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { Todo, TodoStatus, TaskCategory, Database } from '@/types/todos'
import StatusBadge from './StatusBadge'
import PriorityBadge from './PriorityBadge'
import TraceTimeline from './TraceTimeline'

export type RealtimeStatus = 'CONNECTING'|'SUBSCRIBED'|'CHANNEL_ERROR'|'TIMED_OUT'|'CLOSED'
import type { LogEntry } from './BattleLog'

interface Props {
  todos: Todo[]
  setTodos: React.Dispatch<React.SetStateAction<Todo[]>>
  onStatusChange: (s: RealtimeStatus) => void
  onLogEntry?: (e: LogEntry) => void
}

type FilterTab = 'all' | TodoStatus

const TABS: { key: FilterTab; label: string; color: string }[] = [
  { key: 'all',         label: 'ALL',         color: 'text-slate-400 border-slate-600' },
  { key: 'pending',     label: 'PENDING',      color: 'text-slate-400 border-slate-600' },
  { key: 'in_progress', label: 'IN PROGRESS',  color: 'text-cyan-400 border-cyan-600' },
  { key: 'completed',   label: 'COMPLETED',    color: 'text-emerald-400 border-emerald-700' },
  { key: 'failed',      label: 'FAILED',       color: 'text-red-400 border-red-800' },
]

const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }

const CAT_COLORS: Record<TaskCategory, string> = {
  db:       'text-blue-600 border-blue-900/40',
  ui:       'text-purple-600 border-purple-900/40',
  infra:    'text-orange-700 border-orange-900/40',
  analysis: 'text-teal-600 border-teal-900/40',
  other:    'text-slate-700 border-slate-800/40',
}
const CAT_ICONS: Record<TaskCategory, string> = {
  db: '🗄', ui: '🖥', infra: '⚙', analysis: '📊', other: '◈',
}

function CategoryBadge({ category }: { category: TaskCategory }) {
  if (!category || category === 'other') return null
  return (
    <span className={`text-[9px] font-mono border rounded px-1 py-0.5 tracking-wider flex-shrink-0 ${CAT_COLORS[category]}`}>
      {CAT_ICONS[category]} {category.toUpperCase()}
    </span>
  )
}
const NEXT_STATUS: Record<string, TodoStatus> = {
  pending:     'in_progress',
  in_progress: 'completed',
  completed:   'pending',
  failed:      'pending',
  blocked:     'in_progress',
}

function MissionTimer({ deadline }: { deadline: string }) {
  const [remaining, setRemaining] = useState('')
  const [urgent, setUrgent] = useState(false)
  useEffect(() => {
    function update() {
      const diff = new Date(deadline).getTime() - Date.now()
      if (diff <= 0) { setRemaining('EXPIRED'); setUrgent(true); return }
      const h = Math.floor(diff / 3600000)
      const m = Math.floor((diff % 3600000) / 60000)
      const s = Math.floor((diff % 60000) / 1000)
      setUrgent(diff < 3600000)
      setRemaining(h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`)
    }
    update()
    const t = setInterval(update, 1000)
    return () => clearInterval(t)
  }, [deadline])
  return (
    <span className={`text-xs font-mono ${urgent ? 'text-red-400 animate-pulse' : 'text-slate-600'}`}>
      ⏱ {remaining}
    </span>
  )
}

const STATUS_ACCENT: Record<string, string> = {
  pending:     'border-l-slate-600',
  in_progress: 'border-l-cyan-500',
  completed:   'border-l-emerald-600',
  failed:      'border-l-red-700',
  blocked:     'border-l-orange-700',
}
const STATUS_GLOW: Record<string, string> = {
  pending:     '',
  in_progress: 'shadow-[0_0_12px_rgba(0,212,255,0.08)]',
  completed:   'shadow-[0_0_12px_rgba(0,210,115,0.06)]',
  failed:      '',
  blocked:     '',
}

function TaskCard({
  todo, flashing, onStatusUpdate,
}: {
  todo: Todo; flashing: boolean; onStatusUpdate: (s: TodoStatus) => Promise<void>
}) {
  const [expanded, setExpanded] = useState(false)
  const [showTrace, setShowTrace] = useState(false)
  const nextStatus = NEXT_STATUS[todo.status] ?? 'pending'
  const lastComment = todo.comments?.slice(-1)[0]

  return (
    <div
      className={`
        relative border-l-2 rounded-r border border-slate-800/60 bg-black/50
        ${STATUS_ACCENT[todo.status]} ${STATUS_GLOW[todo.status]}
        ${flashing ? 'ring-1 ring-cyan-500/40 bg-cyan-950/20' : ''}
        transition-all duration-500
      `}
    >
      {/* Boss indicator */}
      {todo.is_boss && (
        <div className="absolute -top-px -right-px bg-yellow-500/20 border border-yellow-500/40 rounded-bl text-yellow-400 text-xs px-1.5 py-0.5 font-mono">
          ★ BOSS
        </div>
      )}

      <div className="p-3">
        {/* Top row: priority + status */}
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-1.5 flex-wrap">
            <PriorityBadge priority={todo.priority} />
            <StatusBadge status={todo.status} />
            {todo.task_category && <CategoryBadge category={todo.task_category} />}
          </div>
          <span className="text-slate-700 text-xs font-mono tabular-nums">
            {new Date(todo.updated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>

        {/* Title */}
        <p
          className={`text-sm leading-snug mb-2 cursor-pointer select-none font-medium
            ${todo.is_boss ? 'text-yellow-200 font-semibold' : 'text-white'}
            ${expanded ? '' : 'line-clamp-2'}
          `}
          onClick={() => setExpanded(e => !e)}
          title={expanded ? 'Collapse' : 'Expand'}
        >
          {todo.title}
        </p>

        {/* Agent + deadline row */}
        <div className="flex items-center justify-between gap-2 text-xs font-mono">
          <span className="text-purple-500/80 truncate max-w-[160px]">
            {todo.assigned_agent ?? <span className="text-slate-700">unassigned</span>}
            {(todo.retry_count ?? 0) > 0 && (
              <span className="ml-1 text-yellow-700">↺{todo.retry_count}</span>
            )}
          </span>
          {todo.deadline && <MissionTimer deadline={todo.deadline} />}
        </div>

        {/* Last comment */}
        {lastComment && (
          <div className="mt-2 pt-2 border-t border-slate-800/60">
            <p className="text-xs text-slate-600 line-clamp-2">
              <span className="text-purple-700/80">{lastComment.agent}: </span>
              {lastComment.text}
            </p>
          </div>
        )}

        {/* All comments when expanded */}
        {expanded && (todo.comments?.length ?? 0) > 1 && (
          <div className="mt-2 space-y-1">
            {todo.comments.slice(0, -1).map((c, i) => (
              <p key={i} className="text-xs text-slate-700">
                <span className="text-purple-800">{c.agent}: </span>{c.text}
              </p>
            ))}
          </div>
        )}
      </div>

      {/* Trace timeline */}
      {showTrace && (
        <div className="px-3 pb-2 border-t border-slate-800/40 pt-2">
          <TraceTimeline taskId={todo.id} agentName={todo.assigned_agent} />
        </div>
      )}

      {/* Action footer */}
      <div className="px-3 py-1.5 border-t border-slate-800/50 flex items-center justify-between gap-2">
        <button
          onClick={() => setShowTrace(s => !s)}
          className={`text-[10px] font-mono tracking-wider transition-colors flex-shrink-0 ${
            showTrace ? 'text-cyan-500' : 'text-slate-700 hover:text-slate-500'
          }`}
          title="Show agent trace"
        >
          {showTrace ? '◈ trace ▲' : '◈ trace'}
        </button>
        <span className="text-slate-800 text-xs font-mono flex-1 text-center truncate">{todo.id.slice(0, 8)}…</span>
        <button
          onClick={() => onStatusUpdate(nextStatus)}
          className="text-xs text-slate-600 hover:text-cyan-400 font-mono tracking-wider transition-colors flex-shrink-0"
        >
          {todo.status === 'completed' ? '↺ reopen' :
           todo.status === 'failed'    ? '↺ retry'  :
           todo.status === 'pending'   ? '▶ start'  :
           todo.status === 'blocked'   ? '▶ unblock':
           '✓ complete'}
        </button>
      </div>
    </div>
  )
}

export default function TodosTable({ todos, setTodos, onStatusChange, onLogEntry }: Props) {
  const [activeTab, setActiveTab] = useState<FilterTab>('all')
  const [search, setSearch] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  const flashedIds = useRef<Set<string>>(new Set())
  const flashTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  // Global keyboard: "/" focuses search, Esc clears + blurs
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable

      if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault()
        searchInputRef.current?.focus()
        searchInputRef.current?.select()
        return
      }
      if (e.key === 'Escape' && document.activeElement === searchInputRef.current) {
        setSearch('')
        searchInputRef.current?.blur()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  function flash(id: string) {
    const existing = flashTimers.current.get(id)
    if (existing) clearTimeout(existing)
    flashedIds.current.add(id)
    const timer = setTimeout(() => {
      flashedIds.current.delete(id)
      flashTimers.current.delete(id)
      setTodos(prev => [...prev])
    }, 1500)
    flashTimers.current.set(id, timer)
  }

  useEffect(() => {
    const supabase = createClient()
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let stuckTimer:     ReturnType<typeof setTimeout> | null = null
    let currentChannel: ReturnType<typeof supabase.channel> | null = null
    let attempt = 0
    let disposed = false

    async function pollData() {
      const { data } = await supabase.from('todos').select('*').order('created_at', { ascending: false })
      if (data && !disposed) setTodos(data)
    }

    function connect() {
      if (disposed) return
      attempt++
      onStatusChange('CONNECTING')

      // Fresh channel id per attempt — avoids Supabase refusing to re-subscribe
      // to an already-open channel name after a half-closed socket
      const channelName = `todos-realtime-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

      currentChannel = supabase
        .channel(channelName)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'todos' }, (payload) => {
          const newTodo = payload.new as Todo
          setTodos(prev => [newTodo, ...prev])
          flash(newTodo.id)
          onLogEntry?.({ id: `${newTodo.id}-insert`, at: new Date(), agent: newTodo.assigned_agent, task: newTodo.title, event: 'created' })
        })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'todos' }, (payload) => {
          const updated = payload.new as Todo
          const prev    = payload.old as Partial<Todo>
          setTodos(p => p.map(t => (t.id === updated.id ? updated : t)))
          flash(updated.id)
          if (prev.status !== updated.status) {
            const event: LogEntry['event'] =
              updated.status === 'in_progress' ? 'started' :
              updated.status === 'completed'   ? (updated.is_boss ? 'boss_slain' : 'completed') :
              updated.status === 'failed'      ? 'failed' :
              updated.status === 'blocked'     ? 'blocked' : 'created'
            onLogEntry?.({ id: `${updated.id}-${updated.updated_at}`, at: new Date(), agent: updated.assigned_agent, task: updated.title, event })
          }
        })
        .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'todos' }, (payload) => {
          const deleted = payload.old as Pick<Todo, 'id'>
          setTodos(prev => prev.filter(t => t.id !== deleted.id))
        })
        .subscribe(async (status) => {
          if (disposed) return
          onStatusChange(status as RealtimeStatus)

          if (status === 'SUBSCRIBED') {
            attempt = 0
            if (stuckTimer) { clearTimeout(stuckTimer); stuckTimer = null }
            await pollData()
            return
          }

          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            // Refresh data via REST so the UI stays current while realtime recovers
            pollData().catch(() => {})
            const delay = Math.min(30_000, 2_000 * Math.pow(2, Math.min(attempt, 5)))
            if (reconnectTimer) clearTimeout(reconnectTimer)
            reconnectTimer = setTimeout(() => {
              if (currentChannel) { supabase.removeChannel(currentChannel); currentChannel = null }
              connect()
            }, delay)
          }
        })

      // If we haven't reached SUBSCRIBED in 8s, tear down + retry
      stuckTimer = setTimeout(() => {
        if (disposed) return
        pollData().catch(() => {})
        if (currentChannel) { supabase.removeChannel(currentChannel); currentChannel = null }
        connect()
      }, 8_000)
    }

    connect()
    // Initial data fetch too, so the table renders even before realtime subscribes
    pollData().catch(() => {})

    return () => {
      disposed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (stuckTimer)     clearTimeout(stuckTimer)
      if (currentChannel) {
        currentChannel.unsubscribe()
        supabase.removeChannel(currentChannel)
      }
      flashTimers.current.forEach(t => clearTimeout(t))
      flashTimers.current.clear()
      flashedIds.current.clear()
    }
  }, [])

  const [showOlder, setShowOlder] = useState(false)
  const ONE_HOUR = 60 * 60 * 1000

  const filtered = useMemo(() => {
    const searchLower = search.toLowerCase()
    return todos
      .filter(t => activeTab === 'all' || t.status === activeTab)
      .filter(t => !search || t.title.toLowerCase().includes(searchLower) || (t.assigned_agent ?? '').includes(searchLower))
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
  }, [todos, activeTab, search])

  const { recent, older } = useMemo(() => {
    const now = Date.now()
    const showFailed = activeTab === 'failed'
    const recent: typeof filtered = []
    const older:  typeof filtered = []
    for (const t of filtered) {
      if (!showFailed && t.status === 'failed') continue
      const age = now - new Date(t.updated_at).getTime()
      if (age < ONE_HOUR) recent.push(t)
      else older.push(t)
    }
    return { recent, older }
  }, [filtered, activeTab])

  const counts = useMemo(() => TABS.reduce((acc, tab) => {
    acc[tab.key] = tab.key === 'all'
      ? todos.filter(t => t.status !== 'failed').length
      : todos.filter(t => t.status === tab.key).length
    return acc
  }, {} as Record<FilterTab, number>), [todos])

  return (
    <div className="space-y-3">
      {/* Header bar */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-1 text-xs font-mono text-cyan-700 tracking-widest">
          <span>◈ TASK REGISTRY</span>
          <span className="text-slate-700 ml-2">{todos.length} records</span>
        </div>

        {/* Search */}
        <div className="relative">
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-700 text-xs">⌕</span>
          <input
            ref={searchInputRef}
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="search tasks or agents... (press /)"
            className="bg-black/60 border border-slate-800 rounded text-xs font-mono text-slate-400 pl-7 pr-10 py-1.5 w-60 focus:outline-none focus:border-cyan-800 placeholder:text-slate-700"
          />
          {!search && (
            <kbd className="absolute right-2 top-1/2 -translate-y-1/2 text-[9px] font-mono text-slate-700 border border-slate-800 rounded px-1 py-0.5 pointer-events-none">/</kbd>
          )}
        </div>
      </div>

      {/* Status tabs */}
      <div className="flex items-center gap-1 overflow-x-auto pb-0.5">
        {TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`
              flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-mono tracking-wider whitespace-nowrap
              border transition-all
              ${activeTab === tab.key
                ? `${tab.color} bg-black/60`
                : 'text-slate-700 border-slate-900 hover:text-slate-500 hover:border-slate-800'
              }
            `}
          >
            {tab.label}
            <span className={`text-xs px-1 rounded ${activeTab === tab.key ? 'bg-white/10' : 'bg-slate-900'}`}>
              {counts[tab.key]}
            </span>
          </button>
        ))}
      </div>

      {/* Cards */}
      {filtered.length === 0 ? (
        <div className="rounded border border-slate-800/60 bg-black/40 p-12 text-center font-mono">
          <p className="text-3xl mb-3 opacity-20">◈</p>
          <p className="text-slate-600 tracking-widest text-xs">
            {search ? 'NO MATCHES FOUND' : 'NO TASKS IN THIS CATEGORY'}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Recent — last hour */}
          {recent.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono text-cyan-700 tracking-widest">◈ LAST HOUR</span>
                <span className="text-xs font-mono text-slate-700">{recent.length} tasks</span>
                <div className="flex-1 h-px bg-cyan-900/30" />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
                {recent.map(todo => (
                  <TaskCard
                    key={todo.id}
                    todo={todo}
                    flashing={flashedIds.current.has(todo.id)}
                    onStatusUpdate={async (newStatus) => {
                      const supabase = createClient()
                      await supabase.from('todos').update({ status: newStatus }).eq('id', todo.id)
                    }}
                  />
                ))}
              </div>
            </div>
          )}

          {recent.length === 0 && (
            <div className="rounded border border-slate-800/40 bg-black/30 p-6 text-center font-mono">
              <p className="text-slate-700 text-xs tracking-widest">NO ACTIVITY IN THE LAST HOUR</p>
            </div>
          )}

          {/* Older tasks — collapsible */}
          {older.length > 0 && (
            <div className="space-y-2">
              <button
                onClick={() => setShowOlder(o => !o)}
                className="flex items-center gap-2 w-full group"
              >
                <span className="text-xs font-mono text-slate-600 tracking-widest group-hover:text-slate-500 transition-colors">
                  {showOlder ? '▼' : '▶'} OLDER TASKS
                </span>
                <span className="text-xs font-mono text-slate-700">{older.length} tasks</span>
                <div className="flex-1 h-px bg-slate-800/60" />
                <span className="text-xs font-mono text-slate-700">{showOlder ? 'hide' : 'show'}</span>
              </button>

              {showOlder && (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2 opacity-70">
                  {older.map(todo => (
                    <TaskCard
                      key={todo.id}
                      todo={todo}
                      flashing={flashedIds.current.has(todo.id)}
                      onStatusUpdate={async (newStatus) => {
                        const supabase = createClient()
                        // Retry: clear assigned agent so ruflo picks it up fresh
                        const update: Database['public']['Tables']['todos']['Update'] = { status: newStatus }
                        if (todo.status === 'failed' && newStatus === 'pending') {
                          update.assigned_agent = null
                          update.retry_count = (todo.retry_count ?? 0) + 1
                        }
                        await supabase.from('todos').update(update).eq('id', todo.id)
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
