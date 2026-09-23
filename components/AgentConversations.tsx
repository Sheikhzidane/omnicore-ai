'use client'

import { useEffect, useState, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { factionForPool, FACTION_STYLES } from '@/lib/factions'

interface Turn { role: 'god' | 'specialist'; text: string; at: string }
/** Extracts `metadata.conversation` when it is an array of turns, else null. */
function conversationOf(metadata: unknown): Turn[] | null {
  if (!metadata || typeof metadata !== 'object') return null
  const conversation = (metadata as { conversation?: unknown }).conversation
  return Array.isArray(conversation) ? (conversation as Turn[]) : null
}

interface Conversation {
  taskId:    string
  taskTitle: string
  pool:      string | null
  turns:     Turn[]
  status:    string
  seenAt:    number
}

const MAX_VISIBLE = 5
const TURN_DELAY_MS = 900 // stagger turn reveal so the conversation "types" in

/**
 * Live feed of God + specialist conversations. Subscribes to todos.metadata
 * changes — when a new conversation appears, turns animate in one-by-one.
 * Pure visual upgrade; no cost to the agents themselves.
 */
export default function AgentConversations() {
  const [convos, setConvos] = useState<Conversation[]>([])
  const [visibleTurns, setVisibleTurns] = useState<Record<string, number>>({})
  const seenIds = useRef<Set<string>>(new Set())

  useEffect(() => {
    const supabase = createClient()

    async function hydrate() {
      const { data } = await supabase
        .from('todos')
        .select('id, title, assigned_agent, metadata, status')
        .not('metadata', 'is', null)
        .order('updated_at', { ascending: false })
        .limit(30)

      const seeded: Conversation[] = (data ?? [])
        .flatMap(t => {
          const turns = conversationOf(t.metadata)
          return turns ? [{ ...t, turns }] : []
        })
        .slice(0, MAX_VISIBLE)
        .map(t => ({
          taskId:    t.id,
          taskTitle: t.title,
          pool:      t.assigned_agent?.replace(/-[a-z0-9]{4,}$/, '') ?? null,
          turns:     t.turns,
          status:    t.status,
          seenAt:    Date.now(),
        }))

      for (const c of seeded) {
        seenIds.current.add(c.taskId)
        setVisibleTurns(v => ({ ...v, [c.taskId]: c.turns.length })) // seed as fully-revealed
      }
      setConvos(seeded)
    }
    hydrate()

    const channel = supabase
      .channel('agent-conversations')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'todos' }, (payload) => {
        const row = payload.new as { id: string; title: string; assigned_agent: string | null; status: string; metadata?: { conversation?: Turn[] } } | null
        const conv = row?.metadata?.conversation
        if (!Array.isArray(conv) || !conv.length) return
        if (seenIds.current.has(row!.id)) return
        seenIds.current.add(row!.id)

        const pool = row!.assigned_agent?.replace(/-[a-z0-9]{4,}$/, '') ?? null
        const fresh: Conversation = {
          taskId:    row!.id,
          taskTitle: row!.title,
          pool,
          turns:     conv,
          status:    row!.status,
          seenAt:    Date.now(),
        }

        setConvos(prev => [fresh, ...prev].slice(0, MAX_VISIBLE))
        setVisibleTurns(v => ({ ...v, [fresh.taskId]: 1 })) // reveal first turn immediately
        // Stagger the rest
        for (let i = 1; i < fresh.turns.length; i++) {
          setTimeout(() => {
            setVisibleTurns(v => ({ ...v, [fresh.taskId]: i + 1 }))
          }, i * TURN_DELAY_MS)
        }
      })
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [])

  if (!convos.length) {
    return (
      <div className="rounded border border-slate-800/60 bg-black/40 px-4 py-3">
        <span className="text-xs font-mono tracking-[0.2em] text-slate-500 uppercase">◆ Agent Dialogue</span>
        <div className="text-[11px] font-mono text-slate-600 mt-1">
          No live conversations yet. They appear the moment a task is assigned.
        </div>
      </div>
    )
  }

  return (
    <div className="rounded border border-slate-800/60 bg-black/40 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800/60 bg-black/60">
        <span className="text-xs font-mono tracking-[0.2em] text-slate-500 uppercase">◆ Agent Dialogue</span>
        <span className="text-[10px] font-mono text-slate-600">last {convos.length} · live</span>
      </div>

      <div className="divide-y divide-slate-800/40 max-h-[520px] overflow-y-auto">
        {convos.map(c => {
          const faction = factionForPool(c.pool)
          const specStyle = faction ? FACTION_STYLES[faction.id] : { text: 'text-slate-300', border: 'border-slate-700', bg: 'bg-slate-900/30', fill: 'bg-slate-500' }
          const shown = visibleTurns[c.taskId] ?? c.turns.length

          return (
            <div key={c.taskId} className="px-4 py-3 space-y-2">
              <div className="text-[10px] font-mono text-slate-500 truncate">
                <span className="text-slate-700">task:</span> {c.taskTitle.slice(0, 120)}
              </div>

              {c.turns.slice(0, shown).map((t, i) => {
                const isGod  = t.role === 'god'
                const bubbleStyle = isGod
                  ? 'border-amber-800/50 bg-amber-950/20 text-amber-200'
                  : `${specStyle.border} ${specStyle.bg} ${specStyle.text}`
                const label = isGod ? '◈ GOD' : `${faction?.icon ?? '◎'} ${c.pool ?? 'specialist'}`
                return (
                  <div key={i} className={`flex ${isGod ? 'justify-start' : 'justify-end'}`}>
                    <div className={`max-w-[85%] border rounded-md px-3 py-1.5 ${bubbleStyle}`}
                         style={{ animation: 'bubble-in 0.4s ease-out' }}>
                      <div className={`text-[9px] font-mono tracking-wider mb-0.5 ${isGod ? 'text-amber-500' : 'opacity-70'}`}>{label}</div>
                      <div className="text-[11px] leading-snug font-mono">{t.text}</div>
                    </div>
                  </div>
                )
              })}

              {shown < c.turns.length && (
                <div className={`flex ${c.turns[shown].role === 'god' ? 'justify-start' : 'justify-end'}`}>
                  <div className="text-[11px] font-mono text-slate-600 italic animate-pulse">typing…</div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
