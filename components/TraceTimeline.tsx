'use client'

import type { TraceRow } from '@/types/database'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

type Trace = TraceRow

interface Props {
  taskId: string
  agentName: string | null
}

const TOOL_ICONS: Record<string, string> = {
  read_file:      '📄',
  write_file:     '✏️',
  list_directory: '📁',
  run_sql:        '🔍',
  run_ddl:        '🔧',
  list_tables:    '📋',
  describe_table: '🗂️',
  web_search:     '🌐',
  fetch_url:      '🔗',
  task_complete:  '✅',
}

const TOOL_COLOR: Record<string, string> = {
  read_file:      'text-slate-400',
  write_file:     'text-cyan-400',
  list_directory: 'text-slate-500',
  run_sql:        'text-blue-400',
  run_ddl:        'text-purple-400',
  list_tables:    'text-blue-300',
  describe_table: 'text-blue-300',
  web_search:     'text-green-400',
  fetch_url:      'text-green-300',
  task_complete:  'text-emerald-400',
}

function formatInput(toolName: string, raw: string | null): string {
  if (!raw) return ''
  try {
    const parsed = JSON.parse(raw)
    if (toolName === 'read_file' || toolName === 'write_file' || toolName === 'list_directory')
      return parsed.path ?? raw
    if (toolName === 'run_sql' || toolName === 'run_ddl')
      return (parsed.query ?? parsed.statement ?? raw).slice(0, 120)
    if (toolName === 'web_search') return parsed.query ?? raw
    if (toolName === 'fetch_url') return parsed.url ?? raw
    return JSON.stringify(parsed).slice(0, 120)
  } catch {
    return raw.slice(0, 120)
  }
}

export default function TraceTimeline({ taskId, agentName }: Props) {
  const [traces, setTraces] = useState<Trace[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    const supabase = createClient()

    // Load existing traces
    ;supabase.from('traces')
      .select('*')
      .eq('task_id', taskId)
      .order('created_at', { ascending: true })
      .then(({ data }) => {
        setTraces(data ?? [])
        setLoading(false)
      })

    // Subscribe to new traces as they come in (task is in_progress)
    const channel = supabase
      .channel(`traces-${taskId}-${Date.now()}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'traces', filter: `task_id=eq.${taskId}` },
        ({ new: row }) => {
          setTraces(prev => [...prev, row as Trace])
        }
      )
      .subscribe()

    return () => {
      channel.unsubscribe()
      supabase.removeChannel(channel)
    }
  }, [taskId])

  if (loading) {
    return <div className="py-2 text-xs font-mono text-slate-700 text-center">Loading trace...</div>
  }

  if (traces.length === 0) {
    return <div className="py-2 text-xs font-mono text-slate-700 text-center italic">No trace recorded yet.</div>
  }

  const totalMs = traces.reduce((sum, t) => sum + (t.duration_ms ?? 0), 0)
  const errorCount = traces.filter(t => t.is_error).length

  return (
    <div className="space-y-0.5">
      {/* Summary bar */}
      <div className="flex items-center gap-3 pb-1 mb-1 border-b border-slate-800/60 text-xs font-mono">
        <span className="text-slate-600">{traces.length} calls</span>
        <span className="text-slate-700">{(totalMs / 1000).toFixed(1)}s total</span>
        {errorCount > 0 && <span className="text-red-500">{errorCount} errors</span>}
      </div>

      {/* Tool call timeline */}
      {traces.map((trace, i) => {
        const icon  = TOOL_ICONS[trace.tool_name] ?? '⚡'
        const color = trace.is_error ? 'text-red-400' : (TOOL_COLOR[trace.tool_name] ?? 'text-slate-400')
        const isOpen = expanded === trace.id
        const inputLabel = formatInput(trace.tool_name, trace.input_summary)

        return (
          <div key={trace.id}>
            <button
              onClick={() => setExpanded(isOpen ? null : trace.id)}
              className={`w-full flex items-center gap-2 px-1 py-0.5 rounded text-left hover:bg-slate-900/40 transition-colors group`}
            >
              {/* Step number */}
              <span className="text-slate-700 text-[10px] w-4 tabular-nums flex-shrink-0">{i + 1}</span>

              {/* Tool icon + name */}
              <span className="text-sm flex-shrink-0">{icon}</span>
              <span className={`text-xs font-mono font-semibold flex-shrink-0 ${color}`}>
                {trace.tool_name}
              </span>

              {/* Input preview */}
              <span className="text-xs font-mono text-slate-600 truncate flex-1 min-w-0">
                {inputLabel}
              </span>

              {/* Duration */}
              {trace.duration_ms != null && (
                <span className={`text-[10px] font-mono flex-shrink-0 ${
                  trace.duration_ms > 5000 ? 'text-orange-600' :
                  trace.duration_ms > 1000 ? 'text-yellow-700' : 'text-slate-700'
                }`}>
                  {trace.duration_ms < 1000 ? `${trace.duration_ms}ms` : `${(trace.duration_ms/1000).toFixed(1)}s`}
                </span>
              )}

              <span className="text-slate-700 text-[10px] group-hover:text-slate-500 flex-shrink-0">
                {isOpen ? '▲' : '▼'}
              </span>
            </button>

            {/* Expanded: full input + result */}
            {isOpen && (
              <div className="ml-7 mb-1 space-y-1">
                {trace.input_summary && (
                  <div className="rounded bg-black/40 border border-slate-800/50 px-2 py-1">
                    <div className="text-[10px] font-mono text-slate-700 mb-0.5">INPUT</div>
                    <pre className="text-[10px] font-mono text-slate-500 whitespace-pre-wrap break-all">
                      {trace.input_summary.slice(0, 400)}
                    </pre>
                  </div>
                )}
                {trace.result_summary && trace.result_summary !== 'done' && (
                  <div className={`rounded border px-2 py-1 ${trace.is_error ? 'bg-red-950/20 border-red-900/40' : 'bg-black/40 border-slate-800/50'}`}>
                    <div className="text-[10px] font-mono text-slate-700 mb-0.5">RESULT</div>
                    <pre className={`text-[10px] font-mono whitespace-pre-wrap break-all ${trace.is_error ? 'text-red-400' : 'text-slate-500'}`}>
                      {trace.result_summary.slice(0, 400)}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
