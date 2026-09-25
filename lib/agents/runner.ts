import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
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
