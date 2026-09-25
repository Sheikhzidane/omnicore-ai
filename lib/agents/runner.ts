import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/types/database'
import { getTextProvider } from '@/lib/ai/registry'
import { executeAgentTask, type ExecuteOutcome } from './executor'
import { createSupabaseAgentStore } from './supabase-store'

type Db = SupabaseClient<Database>

/**
 * Agent task cycle (called by /api/cron/agents). Kill switch: nothing runs
 * unless AGENTS_ENABLED is exactly "true". Tasks are claimed with SKIP LOCKED;
 * each runs with a store bound to its own workspace.
 */
export async function runAgentCycle(db: Db, env: Record<string, string | undefined>, limit = 3) {
  const enabled = env.AGENTS_ENABLED === 'true'
  if (!enabled) return { enabled, processed: [] as { taskId: string; status: ExecuteOutcome['status'] }[] }
  const claimed = await db.rpc('claim_agent_tasks', { p_limit: limit })
  if (claimed.error) throw new Error(`claim tasks: ${claimed.error.message}`)
  const processed: { taskId: string; status: ExecuteOutcome['status'] }[] = []
  for (const task of claimed.data ?? []) {
    const agent = (await db.from('agents').select('id, role, status, autonomy, daily_budget_usd, max_actions_per_day').eq('workspace_id', task.workspace_id).eq('id', task.agent_id).single()).data
    if (!agent) {
      await db.from('agent_tasks').update({ status: 'failed', last_error: 'agent not found' }).eq('id', task.id)
      continue
    }
    const store = createSupabaseAgentStore(db, task.workspace_id)
    try {
      const out = await executeAgentTask(task, agent, { store, text: () => getTextProvider(env), agentsEnabled: enabled })
      processed.push({ taskId: task.id, status: out.status })
    } catch (e) {
      await db.from('agent_tasks').update({ status: 'failed', last_error: (e as Error).message.slice(0, 2000) }).eq('id', task.id)
      processed.push({ taskId: task.id, status: 'failed' })
    }
  }
  return { enabled, processed }
}

/**
 * Owner-initiated agent work: queue a task for the character's agent of
 * `role` and (optionally) run it immediately. The same executor, kill switch,
 * capability checks and budgets apply as for scheduled runs.
 */
export async function queueAgentTask(db: Db, env: Record<string, string | undefined>, p: {
  workspaceId: string; characterId: string; role: Database['public']['Tables']['agents']['Row']['role']; type: string; title: string
  input: Record<string, unknown>; userId: string; runNow: boolean
}) {
  const agent = (await db.from('agents').select('id, role, status, autonomy, daily_budget_usd, max_actions_per_day')
    .eq('workspace_id', p.workspaceId).eq('character_id', p.characterId).eq('role', p.role).maybeSingle()).data
  if (!agent) throw new Error(`this character has no ${p.role} agent`)
  if (agent.status !== 'active') throw new Error(`the ${p.role.replace('_', ' ')} agent is ${agent.status} — enable it in AI Agents → Control Centre`)
  const ins = await db.from('agent_tasks').insert({
    workspace_id: p.workspaceId, character_id: p.characterId, agent_id: agent.id, type: p.type, title: p.title.slice(0, 300),
    input: p.input as Json, status: 'queued', created_by_user: p.userId,
  }).select('*').single()
  if (ins.error) throw new Error(ins.error.message)
  if (!p.runNow) return { taskId: ins.data.id, outcome: null }
  const enabled = env.AGENTS_ENABLED === 'true'
  if (!enabled) return { taskId: ins.data.id, outcome: { status: 'policy_blocked' as const, error: 'AGENTS_ENABLED is not "true" — the task is queued and will run once agents are enabled.' } }
  // Conditional claim: only one runner can move it from queued to running.
  const claimed = await db.from('agent_tasks').update({ status: 'running', attempts: ins.data.attempts + 1 })
    .eq('id', ins.data.id).eq('status', 'queued').select('*').maybeSingle()
  if (!claimed.data) return { taskId: ins.data.id, outcome: null }
  const out = await executeAgentTask(claimed.data, agent, { store: createSupabaseAgentStore(db, p.workspaceId), text: () => getTextProvider(env), agentsEnabled: enabled })
  return { taskId: ins.data.id, outcome: out.status === 'succeeded' ? { status: out.status, result: out.result } : { status: out.status, error: out.error } }
}

export function describeOutcome(o: Awaited<ReturnType<typeof queueAgentTask>>['outcome']): string {
  if (!o) return 'Task queued.'
  if (o.status === 'succeeded') return 'Done.'
  return `Task ${o.status.replace('_', ' ')}: ${'error' in o ? o.error : ''}`
}
