import type { Metadata } from 'next'
import Link from 'next/link'
import { createClient } from '@supabase/supabase-js'
import type { Todo } from '@/types/todos'

interface PageProps { params: Promise<{ id: string }> }

export const dynamic = 'force-dynamic'

async function getTodo(id: string): Promise<Todo | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  const sb = createClient(url, key)
  const { data } = await sb.from('todos').select('*').eq('id', id).single()
  return (data as Todo | null) ?? null
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params
  const todo = await getTodo(id)
  if (!todo) return { title: 'Task not found' }
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://task-dashboard-sigma-three.vercel.app'
  const ogTitle = todo.title.slice(0, 100)
  return {
    title:       `${todo.title.slice(0, 60)} — Pantheon Task`,
    description: `An autonomous AI task: ${todo.title}. Status: ${todo.status}. ${todo.comments.length} agent comment${todo.comments.length === 1 ? '' : 's'}.`,
    openGraph:   {
      title:       todo.title.slice(0, 100),
      description: `Status: ${todo.status} · Agent: ${todo.assigned_agent ?? 'unassigned'}`,
      type:        'article',
      url:         `${site}/share/${id}`,
      images:      [`${site}/api/og?title=${encodeURIComponent(ogTitle)}&category=Task`],
    },
    twitter: { card: 'summary_large_image' },
  }
}

const STATUS_COLORS: Record<string, string> = {
  completed:    'text-emerald-400',
  failed:       'text-red-400',
  in_progress:  'text-cyan-400',
  blocked:      'text-amber-400',
  pending:      'text-slate-400',
  proposed:     'text-purple-400',
  vetoed:       'text-slate-600',
}

/**
 * Public, read-only view of a single task's full life. Intended for sharing
 * a particular agent run on social media. Renders the same data as the trace
 * drawer but as a permalinkable HTML page (so OG cards work, search engines
 * can index, etc).
 */
export default async function SharedTask({ params }: PageProps) {
  const { id } = await params
  const todo = await getTodo(id)

  if (!todo) {
    return (
      <main className="min-h-screen bg-slate-950 px-4 py-10 flex items-center justify-center">
        <div className="text-center">
          <div className="text-[10px] font-mono tracking-[0.25em] text-slate-600 uppercase mb-2">404</div>
          <h1 className="text-xl text-slate-200 mb-4">Task not found</h1>
          <Link href="/ops" className="text-[12px] font-mono text-cyan-400 hover:text-cyan-300">← back to ops dashboard</Link>
        </div>
      </main>
    )
  }

  const ageMs = new Date(todo.updated_at).getTime() - new Date(todo.created_at).getTime()
  const ageH  = Math.round(ageMs / 3_600_000)

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-10">
      <article className="max-w-2xl mx-auto">
        <nav className="text-[10px] font-mono text-slate-500 mb-6">
          <Link href="/ops" className="hover:text-cyan-400">◈ pantheon</Link>
          <span className="mx-2">/</span>
          <span>shared task</span>
        </nav>

        <div className="rounded border border-slate-800/60 bg-black/40 overflow-hidden">
          <header className="px-5 py-4 border-b border-slate-800/60 bg-black/60">
            <div className="text-[10px] font-mono tracking-[0.25em] text-cyan-400 uppercase mb-2">◆ Autonomous Task</div>
            <h1 className="text-xl font-bold text-slate-100 leading-snug">{todo.title}</h1>
          </header>

          <div className="px-5 py-4 grid grid-cols-2 gap-x-4 gap-y-2 text-[12px] font-mono border-b border-slate-800/40">
            <div><span className="text-slate-600">status:</span> <span className={STATUS_COLORS[todo.status] ?? 'text-slate-400'}>{todo.status}</span></div>
            <div><span className="text-slate-600">priority:</span> <span className="text-slate-300">{todo.priority}</span></div>
            <div className="col-span-2 truncate"><span className="text-slate-600">agent:</span> <span className="text-purple-400">{todo.assigned_agent ?? '—'}</span></div>
            <div><span className="text-slate-600">duration:</span> <span className="text-slate-300">{ageH}h</span></div>
            <div><span className="text-slate-600">retries:</span> <span className={todo.retry_count > 0 ? 'text-amber-400' : 'text-slate-500'}>{todo.retry_count}</span></div>
            <div className="col-span-2"><span className="text-slate-600">category:</span> <span className="text-slate-300">{todo.task_category}</span></div>
          </div>

          <div className="px-5 py-4">
            <div className="text-[10px] font-mono tracking-[0.25em] text-slate-500 uppercase mb-3">◇ Agent Trail</div>
            <div className="relative pl-4 border-l border-slate-800/60 space-y-4">
              <TimelineEntry agent="system" time={todo.created_at} text="Task created" dot="bg-slate-600" />
              {todo.comments.map((c, i) => (
                <TimelineEntry key={i} agent={c.agent} time={c.at} text={c.text} dot="bg-cyan-600" />
              ))}
              <TimelineEntry agent="status" time={todo.updated_at} text={`Final: ${todo.status}`} dot={
                todo.status === 'completed' ? 'bg-emerald-500' :
                todo.status === 'failed'    ? 'bg-red-500'     : 'bg-slate-600'
              } />
            </div>
          </div>

          <footer className="px-5 py-3 border-t border-slate-800/60 bg-black/40 flex items-center justify-between text-[10px] font-mono text-slate-700">
            <span>id: {todo.id}</span>
            <Link href="/ops" className="text-cyan-500 hover:text-cyan-300">see live dashboard →</Link>
          </footer>
        </div>

        <p className="text-center text-[11px] font-mono text-slate-600 mt-6">
          this task was completed by an autonomous AI agent system —{' '}
          <Link href="/topics" className="text-cyan-500 hover:text-cyan-300">read about how it works</Link>
        </p>
      </article>
    </main>
  )
}

function TimelineEntry({ agent, time, text, dot }: { agent: string; time: string; text: string; dot: string }) {
  const ago = (() => {
    const ms = Date.now() - new Date(time).getTime()
    if (ms < 60_000)     return `${Math.round(ms / 1000)}s ago`
    if (ms < 3_600_000)  return `${Math.round(ms / 60_000)}m ago`
    if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`
    return `${Math.round(ms / 86_400_000)}d ago`
  })()
  return (
    <div className="relative">
      <span className={`absolute -left-[21px] top-1.5 w-2.5 h-2.5 rounded-full ${dot}`} />
      <div className="flex items-baseline gap-2 mb-1">
        <span className="text-[12px] font-mono text-purple-400">{agent}</span>
        <span className="text-[10px] font-mono text-slate-600">{ago}</span>
      </div>
      <div className="text-[13px] text-slate-300 leading-relaxed whitespace-pre-wrap">{text}</div>
    </div>
  )
}
