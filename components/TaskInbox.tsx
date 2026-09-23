'use client'

import { useEffect, useMemo, useState } from 'react'
import type { Todo } from '@/types/todos'

interface Props {
  todos: Todo[]
}

const PRIORITY_COLOR: Record<string, string> = {
  critical: 'text-red-400 border-red-900/50',
  high:     'text-orange-400 border-orange-900/50',
  medium:   'text-cyan-400 border-cyan-900/50',
  low:      'text-slate-500 border-slate-700/50',
}

// Priority order for sorting proposed tasks (most urgent first)
const PRIORITY_ORDER: Record<string, number> = {
  critical: 0, high: 1, medium: 2, low: 3,
}

export default function TaskInbox({ todos }: Props) {
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)
  const [ghConfigured, setGhConfigured] = useState(false)

  useEffect(() => {
    fetch('/api/github/issues/sync')
      .then(r => r.json() as Promise<{ configured: boolean }>)
      .then(j => setGhConfigured(j.configured))
      .catch(() => {})
  }, [])

  async function syncGitHub() {
    setSyncing(true)
    setSyncMsg(null)
    try {
      const r = await fetch('/api/github/issues/sync', { method: 'POST' })
      const j = await r.json() as { imported?: number; skipped?: number; total?: number; error?: string }
      if (!r.ok) throw new Error(j.error ?? 'sync failed')
      setSyncMsg(`✓ Imported ${j.imported ?? 0} · skipped ${j.skipped ?? 0} (already in inbox)`)
    } catch (e) {
      setSyncMsg(`✗ ${e instanceof Error ? e.message : 'sync failed'}`)
    } finally {
      setSyncing(false)
      setTimeout(() => setSyncMsg(null), 5000)
    }
  }

  // Sort by priority (critical → high → medium → low) then recency
  const proposed = useMemo(
    () => todos
      .filter(t => t.status === 'proposed')
      .sort((a, b) => {
        const pd = (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2)
        return pd !== 0 ? pd : b.created_at.localeCompare(a.created_at)
      }),
    [todos],
  )

  // Derived counts for tier badges
  const criticalCount = useMemo(() => proposed.filter(t => t.priority === 'critical').length, [proposed])
  const highCount     = useMemo(() => proposed.filter(t => t.priority === 'high').length, [proposed])

  async function decide(id: string, approve: boolean) {
    await fetch('/api/todos', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, status: approve ? 'pending' : 'vetoed' }),
    })
  }

  /** Approve only tasks whose priority matches one of the given tiers */
  async function approveByPriority(...priorities: string[]) {
    const targets = proposed.filter(t => priorities.includes(t.priority))
    await Promise.all(targets.map(t =>
      fetch('/api/todos', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: t.id, status: 'pending' }),
      })
    ))
  }

  async function approveAll() {
    await Promise.all(proposed.map(t =>
      fetch('/api/todos', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: t.id, status: 'pending' }),
      })
    ))
  }

  async function vetoAll() {
    await Promise.all(proposed.map(t =>
      fetch('/api/todos', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: t.id, status: 'vetoed' }),
      })
    ))
  }

  return (
    <div className="rounded border border-slate-800/60 bg-black/40 overflow-hidden">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800/60 bg-black/60 gap-2 flex-wrap">
        <div className="flex items-center gap-3">
          <span className="text-xs font-mono tracking-[0.2em] text-slate-500 uppercase">◈ Task Inbox</span>
          {proposed.length > 0 && (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-950/60 text-amber-400 border border-amber-900/50">
              {proposed.length} PENDING REVIEW
            </span>
          )}
        </div>

        {/* ── Action buttons ─────────────────────────────────────────── */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {ghConfigured && (
            <button
              onClick={syncGitHub}
              disabled={syncing}
              className="text-[10px] font-mono px-2 py-0.5 rounded border border-purple-900/50 text-purple-400 hover:bg-purple-950/30 disabled:opacity-40 transition-colors"
            >
              {syncing ? '… SYNCING' : '⬇ SYNC GH'}
            </button>
          )}

          {proposed.length > 0 && (
            <>
              {/* Priority-tier fast-approve buttons — shown only when there are ≥1 of that tier */}
              {criticalCount > 0 && (
                <button
                  onClick={() => approveByPriority('critical')}
                  title={`Approve all ${criticalCount} CRITICAL task${criticalCount !== 1 ? 's' : ''}`}
                  className="text-[10px] font-mono px-2 py-0.5 rounded border border-red-900/60 text-red-400 hover:bg-red-950/30 transition-colors"
                >
                  ✓ CRIT ({criticalCount})
                </button>
              )}
              {highCount > 0 && (
                <button
                  onClick={() => approveByPriority('high')}
                  title={`Approve all ${highCount} HIGH task${highCount !== 1 ? 's' : ''}`}
                  className="text-[10px] font-mono px-2 py-0.5 rounded border border-orange-900/60 text-orange-400 hover:bg-orange-950/30 transition-colors"
                >
                  ✓ HIGH ({highCount})
                </button>
              )}
              {(criticalCount > 0 || highCount > 0) && criticalCount + highCount < proposed.length && (
                <button
                  onClick={() => approveByPriority('critical', 'high')}
                  title={`Approve all ${criticalCount + highCount} critical + high priority tasks`}
                  className="text-[10px] font-mono px-2 py-0.5 rounded border border-amber-900/60 text-amber-400 hover:bg-amber-950/30 transition-colors"
                >
                  ✓ URGENT ({criticalCount + highCount})
                </button>
              )}

              <div className="w-px h-4 bg-slate-800 flex-shrink-0" />

              <button
                onClick={approveAll}
                className="text-[10px] font-mono px-2 py-0.5 rounded border border-green-900/50 text-green-400 hover:bg-green-950/30 transition-colors"
              >
                ✓ ALL
              </button>
              <button
                onClick={vetoAll}
                className="text-[10px] font-mono px-2 py-0.5 rounded border border-red-900/50 text-red-400 hover:bg-red-950/30 transition-colors"
              >
                ✗ VETO ALL
              </button>
            </>
          )}
        </div>
      </div>

      {syncMsg && (
        <div className={`px-4 py-1.5 border-b border-slate-800/40 text-[10px] font-mono ${
          syncMsg.startsWith('✓') ? 'text-green-400 bg-green-950/20' : 'text-red-400 bg-red-950/20'
        }`}>
          {syncMsg}
        </div>
      )}

      {proposed.length === 0 ? (
        <div className="px-4 py-6 text-center text-[11px] font-mono text-slate-600">
          No tasks awaiting approval — God is either thinking or auto-approve is on.
        </div>
      ) : (
        <div className="divide-y divide-slate-800/40">
          {proposed.slice(0, 20).map(t => {
            const lastComment = t.comments?.slice(-1)[0]
            const hasHistory  = (t.retry_count ?? 0) > 0

            return (
              <div key={t.id} className="px-4 py-2.5 flex items-center gap-3 hover:bg-slate-900/30 group">
                {/* Priority badge */}
                <span className={`text-[9px] font-mono font-bold uppercase px-1.5 py-0.5 rounded border flex-shrink-0 ${PRIORITY_COLOR[t.priority] ?? PRIORITY_COLOR.medium}`}>
                  {t.priority}
                </span>

                {/* Task info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-xs text-slate-300 truncate">{t.title}</span>
                    {/* Retry history badge — warns operator this task has failed before */}
                    {hasHistory && (
                      <span
                        className="text-[9px] font-mono text-yellow-700 flex-shrink-0 tabular-nums"
                        title={`This task has been retried ${t.retry_count} time${t.retry_count !== 1 ? 's' : ''} previously`}
                      >
                        ↺{t.retry_count}
                      </span>
                    )}
                  </div>
                  <div className="text-[9px] font-mono text-slate-600 mt-0.5 flex items-center gap-2 flex-wrap">
                    <span>→ {t.assigned_agent ?? 'unassigned'}</span>
                    <span>·</span>
                    <span>{t.task_category}</span>
                    <span>·</span>
                    <span>{timeAgo(t.created_at)}</span>
                    {/* Show last agent comment as context for the decision */}
                    {lastComment && (
                      <>
                        <span>·</span>
                        <span className="text-slate-700 italic truncate max-w-[200px]" title={lastComment.text}>
                          &ldquo;{lastComment.text.slice(0, 60)}{lastComment.text.length > 60 ? '…' : ''}&rdquo;
                        </span>
                      </>
                    )}
                  </div>
                </div>

                {/* Approve / Veto buttons */}
                <div className="flex gap-1.5 shrink-0">
                  <button
                    onClick={() => decide(t.id, true)}
                    title="Approve — queue for agent"
                    className="text-[10px] font-mono px-2 py-1 rounded border border-green-900/50 text-green-400 hover:bg-green-950/40 transition-colors"
                  >
                    ✓
                  </button>
                  <button
                    onClick={() => decide(t.id, false)}
                    title="Veto — never run"
                    className="text-[10px] font-mono px-2 py-1 rounded border border-red-900/50 text-red-400 hover:bg-red-950/40 transition-colors"
                  >
                    ✗
                  </button>
                </div>
              </div>
            )
          })}

          {proposed.length > 20 && (
            <div className="px-4 py-2 text-[9px] font-mono text-slate-600 text-center">
              +{proposed.length - 20} more awaiting review
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
