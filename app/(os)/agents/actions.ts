'use server'

import { z } from 'zod'
import { recordAudit } from '@/lib/audit'
import { runAction, formObject, type ActionResult } from '@/lib/actions'
import { AGENT_DEFINITIONS } from '@/lib/agents/definitions'
import { queueAgentTask, describeOutcome } from '@/lib/agents/runner'
import type { AgentRole, Json } from '@/types/database'

const Id = z.uuid()
const ROLES = Object.keys(AGENT_DEFINITIONS) as [AgentRole, ...AgentRole[]]

export async function updateAgent(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('admin', async ({ db, workspace, user }) => {
    const f = z.object({
      agentId: Id, status: z.enum(['disabled', 'active', 'paused']), autonomy: z.enum(['suggest_only', 'approval_required', 'autonomous_within_limits']),
      dailyBudgetUsd: z.coerce.number().min(0).max(100), maxActionsPerDay: z.coerce.number().int().min(0).max(500),
    }).parse(formObject(fd))
    const ok = await recordAudit({ workspaceId: workspace.id, actorType: 'user', actorId: user.id, action: 'agent.update', entityType: 'agent', entityId: f.agentId, details: { status: f.status, autonomy: f.autonomy, budget: f.dailyBudgetUsd, maxActions: f.maxActionsPerDay } })
    if (!ok) throw new Error('audit log unavailable')
    const up = await db.from('agents').update({ status: f.status, autonomy: f.autonomy, daily_budget_usd: f.dailyBudgetUsd, max_actions_per_day: f.maxActionsPerDay }).eq('workspace_id', workspace.id).eq('id', f.agentId)
    if (up.error) throw new Error(up.error.message)
    return 'Agent updated.'
  }, ['/agents'])
}

export async function bulkAgents(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('admin', async ({ db, workspace, user }) => {
    const characterId = Id.parse(fd.get('characterId'))
    const status = z.enum(['disabled', 'active', 'paused']).parse(fd.get('status'))
    await recordAudit({ workspaceId: workspace.id, actorType: 'user', actorId: user.id, action: 'agent.bulk_update', entityType: 'character', entityId: characterId, details: { status } })
    const up = await db.from('agents').update({ status }).eq('workspace_id', workspace.id).eq('character_id', characterId)
    if (up.error) throw new Error(up.error.message)
    return `All agents set to ${status}.`
  }, ['/agents'])
}

export async function ensureRoster(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('admin', async ({ db, workspace }) => {
    const characterId = Id.parse(fd.get('characterId'))
    const { data } = await db.from('agents').select('role').eq('workspace_id', workspace.id).eq('character_id', characterId)
    const have = new Set((data ?? []).map(a => a.role))
    const missing = ROLES.filter(r => !have.has(r))
    if (missing.length) {
      const ins = await db.from('agents').insert(missing.map(role => ({ workspace_id: workspace.id, character_id: characterId, role, name: AGENT_DEFINITIONS[role].name, status: 'disabled' as const })))
      if (ins.error) throw new Error(ins.error.message)
    }
    return missing.length ? `Added ${missing.length} agents (disabled).` : 'Roster already complete.'
  }, ['/agents'])
}

/** A human creates and (optionally) runs a task. Input is validated against the task's schema before queueing. */
export async function createTask(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace, user }) => {
    const f = formObject(fd)
    const characterId = Id.parse(f.characterId)
    const [role, type] = String(f.task ?? '').split('.') as [AgentRole, string]
    const def = AGENT_DEFINITIONS[role]?.tasks[type]
    if (!def) throw new Error('choose a task')
    let raw: unknown
    try { raw = JSON.parse(String(f.input || '{}')) } catch { throw new Error('input must be valid JSON') }
    const input = def.input.parse(raw) as Record<string, unknown>
    const r = await queueAgentTask(db, process.env, { workspaceId: workspace.id, characterId, role, type, title: String(f.title || def.description).slice(0, 300), input, userId: user.id, runNow: f.runNow === 'on' })
    return describeOutcome(r.outcome)
  }, ['/agents/tasks'])
}

/** Agent-proposed (delegated) tasks wait for a human to queue them. */
export async function decideProposedTask(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace, user }) => {
    const taskId = Id.parse(fd.get('taskId'))
    const accept = fd.get('accept') === 'true'
    const task = (await db.from('agent_tasks').select('*').eq('workspace_id', workspace.id).eq('id', taskId).eq('status', 'proposed').single()).data
    if (!task) throw new Error('task is not awaiting a decision')
    if (accept) {
      const agent = (await db.from('agents').select('role').eq('id', task.agent_id).single()).data
      const def = agent ? AGENT_DEFINITIONS[agent.role].tasks[task.type] : undefined
      if (!def) throw new Error(`the ${agent?.role ?? 'target'} agent has no task type "${task.type}" — cancel it`)
      const valid = def.input.safeParse(task.input)
      if (!valid.success) throw new Error('the proposed input is invalid for that task — cancel it')
      await db.from('agent_tasks').update({ status: 'queued', approved_by: user.id, approved_at: new Date().toISOString(), input: valid.data as Json }).eq('id', taskId)
    } else {
      await db.from('agent_tasks').update({ status: 'cancelled' }).eq('id', taskId)
    }
    await recordAudit({ workspaceId: workspace.id, actorType: 'user', actorId: user.id, action: accept ? 'agent_task.approve' : 'agent_task.cancel', entityType: 'agent_task', entityId: taskId })
    return accept ? 'Queued.' : 'Cancelled.'
  }, ['/agents/tasks'])
}

export async function cancelTask(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace }) => {
    const taskId = Id.parse(fd.get('taskId'))
    const up = await db.from('agent_tasks').update({ status: 'cancelled' }).eq('workspace_id', workspace.id).eq('id', taskId).in('status', ['proposed', 'pending', 'queued', 'failed']).select('id')
    if (!up.data?.length) throw new Error('task cannot be cancelled in its current state')
    return 'Cancelled.'
  }, ['/agents/tasks', '/agents/failures'])
}

export async function requeueTask(_: ActionResult, fd: FormData): Promise<ActionResult> {
  return runAction('editor', async ({ db, workspace }) => {
    const taskId = Id.parse(fd.get('taskId'))
    const up = await db.from('agent_tasks').update({ status: 'queued', attempts: 0, last_error: null }).eq('workspace_id', workspace.id).eq('id', taskId).eq('status', 'failed').select('id')
    if (!up.data?.length) throw new Error('only failed tasks can be re-queued')
    return 'Re-queued.'
  }, ['/agents/failures', '/agents/tasks'])
}
