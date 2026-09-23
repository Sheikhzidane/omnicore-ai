import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import DashboardShell from '@/components/DashboardShell'
import { DEMO_TODOS } from '@/lib/demoData'

interface PageProps { searchParams: Promise<{ demo?: string }> }

export default async function DashboardPage({ searchParams }: PageProps) {
  const params = await searchParams
  const isDemo = params.demo === '1'

  // Demo mode: skip the DB hit entirely so first-time visitors see a populated
  // dashboard even without Supabase wired up.
  if (isDemo) {
    return (
      <main className="max-w-7xl mx-auto p-6 space-y-6">
        <div className="rounded border border-cyan-700/50 bg-cyan-950/20 px-4 py-2 text-[11px] font-mono text-cyan-300">
          ◈ DEMO MODE — synthetic data, no live agents. <Link href="/" className="underline hover:text-cyan-200">exit demo</Link>
        </div>
        <DashboardShell initialTodos={DEMO_TODOS} />
      </main>
    )
  }

  const supabase = await createClient()
  const { data: initialTodos } = await supabase
    .from('todos')
    .select('*')
    .order('created_at', { ascending: false })

  return (
    <main className="max-w-7xl mx-auto p-6 space-y-6">
      <DashboardShell initialTodos={initialTodos ?? []} />
    </main>
  )
}
