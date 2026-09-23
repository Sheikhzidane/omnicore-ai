'use client'

import { useEffect, useState } from 'react'
import type { Todo } from '@/types/todos'

interface Props {
  todo: Todo | null
  onClose: () => void
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000)       return `${Math.round(ms / 1000)}s ago`
  if (ms < 3_600_000)    return `${Math.round(ms / 60_000)}m ago`
  if (ms < 86_400_000)   return `${Math.round(ms / 3_600_000)}h ago`
  return `${Math.round(ms / 86_400_000)}d ago`
}

/**
 * Slide-over that shows the full life of a task: God's routing decision,
 * every comment/tool call, status transitions, retry count. Opens on
 * any TaskInbox / TodosTable / Kanban row click.
 */
export default function TaskTraceDrawer({ todo, onClose }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!todo) return null

  const ageMs        = new Date(todo.updated_at).getTime() - new Date(todo.created_at).getTime()
  const ageLabel     = ageMs < 60_000 ? `${Math.round(ageMs / 1000)}s` :
                       ageMs < 3_600_000 ? `${Math.round(ageMs / 60_000)}m` :
                       ageMs < 86_400_000 ? `${Math.round(ageMs / 3_600_000)}h` :
                       `${Math.round(ageMs / 86_400_000)}d`
  const statusColor  =
    todo.status === 'completed'   ? 'text-emerald-400' :
    todo.status === 'failed'      ? 'text-red-400'     :
    todo.status === 'in_progress' ? 'text-cyan-400'    :
    todo.status === 'blocked'     ? 'text-amber-400'   :
                                    'text-slate-500'

  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true">
      <button aria-label="Close trace" onClick={onClose} className="flex-1 bg-black/60 backdrop-blur-sm" />

      <aside className="w-full max-w-lg h-full bg-slate-950 border-l border-slate-800 overflow-y-auto animate-in slide-in-from-right duration-200">
        <header className="sticky top-0 z-10 px-4 py-3 border-b border-slate-800 bg-black/80 backdrop-blur">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] font-mono tracking-[0.2em] text-slate-500 uppercase mb-1">◆ Task Trace</div>
              <div className="text-sm font-semibold text-slate-200 break-words">{todo.title}</div>
            </div>
            <button
              onClick={onClose}
              className="text-slate-500 hover:text-slate-200 text-xl leading-none px-2"
              aria-label="Close"
            >×</button>
          </div>
        </header>

        {/* Summary strip */}
        <div className="px-4 py-3 border-b border-slate-800/60 grid grid-cols-2 gap-x-4 gap-y-2 text-[11px] font-mono">
          <div><span className="text-slate-600">status:</span> <span className={statusColor}>{todo.status}</span></div>
          <div><span className="text-slate-600">priority:</span> <span className="text-slate-300">{todo.priority}</span></div>
          <div className="col-span-2 truncate"><span className="text-slate-600">agent:</span> <span className="text-purple-400">{todo.assigned_agent ?? '—'}</span></div>
          <div><span className="text-slate-600">age:</span> <span className="text-slate-300">{ageLabel}</span></div>
          <div><span className="text-slate-600">retries:</span> <span className={todo.retry_count > 0 ? 'text-amber-400' : 'text-slate-500'}>{todo.retry_count}</span></div>
          <div><span className="text-slate-600">category:</span> <span className="text-slate-300">{todo.task_category}</span></div>
          {todo.deadline && <div><span className="text-slate-600">deadline:</span> <span className="text-slate-300">{new Date(todo.deadline).toLocaleString()}</span></div>}
        </div>

        {todo.status === 'failed' && <WhyDidThisFail todo={todo} />}

        {/* Timeline */}
        <div className="px-4 py-3">
          <div className="text-[10px] font-mono tracking-[0.2em] text-slate-500 uppercase mb-3">◇ Timeline</div>
          <div className="relative pl-4 border-l border-slate-800/60 space-y-4">
            <TimelineEntry
              dot="bg-slate-600"
              agent="system"
              time={todo.created_at}
              text="Task created"
            />
            {todo.comments.map((c, i) => (
              <TimelineEntry
                key={i}
                dot="bg-cyan-600"
                agent={c.agent}
                time={c.at}
                text={c.text}
              />
            ))}
            <TimelineEntry
              dot={
                todo.status === 'completed'   ? 'bg-emerald-500' :
                todo.status === 'failed'      ? 'bg-red-500'     :
                todo.status === 'in_progress' ? 'bg-cyan-500 animate-pulse' :
                                                'bg-slate-600'
              }
              agent="status"
              time={todo.updated_at}
              text={`Now: ${todo.status}`}
            />
          </div>
        </div>

        <footer className="px-4 py-3 border-t border-slate-800/60 text-[10px] font-mono text-slate-600">
          id: {todo.id}
        </footer>
      </aside>
    </div>
  )
}

/**
 * Asks God to explain a failure in 2-3 sentences using the existing
 * /api/god-chat endpoint. Cached per-task in localStorage so re-opening
 * the drawer doesn't re-spend tokens on the same explanation.
 */
function WhyDidThisFail({ todo }: { todo: Todo }) {
  const [explanation, setExplanation] = useState<string | null>(null)
  const [loading, setLoading]         = useState(false)
  const [error, setError]             = useState<string | null>(null)
  const cacheKey = `why-failed:${todo.id}`

  useEffect(() => {
    try {
      const cached = localStorage.getItem(cacheKey)
      if (cached) setExplanation(cached)
    } catch {}
  }, [cacheKey])

  async function ask() {
    setLoading(true)
    setError(null)
    try {
      const lastComments = todo.comments.slice(-3).map(c => `[${c.agent}] ${c.text}`).join('\n')
      const question = `In 2-3 short sentences, explain why this task probably failed and what to try next. Task title: "${todo.title}". Assigned to: ${todo.assigned_agent ?? 'unknown'}. Retries: ${todo.retry_count}. Recent comments:\n${lastComments || '(none)'}`
      const res = await fetch('/api/god-chat', {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({ question }),
      })
      const json = await res.json() as { reply?: string; error?: string }
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      const reply = json.reply ?? '(no reply)'
      setExplanation(reply)
      try { localStorage.setItem(cacheKey, reply) } catch {}
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="px-4 py-3 border-b border-red-900/30 bg-red-950/10">
      <div className="text-[10px] font-mono tracking-[0.2em] text-red-400 uppercase mb-2">⚠ Why did this fail?</div>
      {explanation ? (
        <div className="text-[11px] font-mono text-slate-300 leading-relaxed whitespace-pre-wrap">{explanation}</div>
      ) : error ? (
        <div className="text-[11px] font-mono text-red-400">Couldn&apos;t ask God: {error}</div>
      ) : (
        <button
          onClick={ask}
          disabled={loading}
          className="text-[11px] font-mono text-red-300 hover:text-red-200 tracking-wider uppercase border border-red-800/40 rounded px-2 py-1 disabled:opacity-50"
        >
          {loading ? 'thinking…' : '◉ ask god to explain'}
        </button>
      )}
    </div>
  )
}

function TimelineEntry({ dot, agent, time, text }: { dot: string; agent: string; time: string; text: string }) {
  return (
    <div className="relative">
      <span className={`absolute -left-[21px] top-1 w-2.5 h-2.5 rounded-full ${dot}`} />
      <div className="flex items-baseline gap-2 mb-0.5">
        <span className="text-[11px] font-mono text-purple-400">{agent}</span>
        <span className="text-[10px] font-mono text-slate-600">{timeAgo(time)}</span>
      </div>
      <div className="text-[12px] text-slate-400 leading-relaxed break-words whitespace-pre-wrap">{text}</div>
    </div>
  )
}
