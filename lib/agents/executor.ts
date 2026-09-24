import { z } from 'zod'
import type { AgentRow, AgentTaskRow, Json } from '@/types/database'
import { buildCharacterSystemPrompt } from '@/lib/characters/identity'
import { ProviderNotConfiguredError, ProviderOutputError, ProviderRefusalError, isRetryable } from '@/lib/ai/errors'
import type { TextProvider } from '@/lib/ai/types'
import { AGENT_DEFINITIONS, taskDefinition } from './definitions'
import { authorizeAgentAction } from './permissions'
import type { AgentStore, EffectContext } from './store'

/**
 * Runs ONE claimed agent task end to end:
 *
 *   definition lookup → capability authorisation (every capability) →
 *   input validation → budget & daily-action limits → character identity →
 *   provider call (structured output) → output validation → fixed effect
 *   handler → run log + cost → task completion
 *
 * Every outcome is recorded in agent_runs / agent_run_events. Failures are
 * classified: policy/budget/config/validation → not retried; transient
 * provider errors → retried (up to the task's max_attempts).
 */

export interface ExecuteDeps {
  store: AgentStore
  text: TextProvider | (() => TextProvider)
  agentsEnabled: boolean
}

export type ExecuteOutcome =
  | { status: 'succeeded'; runId: string; result: Record<string, unknown> }
  | { status: 'failed' | 'budget_exceeded' | 'policy_blocked'; runId: string; error: string; retry: boolean }

type Agent = Pick<AgentRow, 'id' | 'role' | 'status' | 'autonomy' | 'daily_budget_usd' | 'max_actions_per_day'>
type Task = Pick<AgentTaskRow, 'id' | 'workspace_id' | 'character_id' | 'agent_id' | 'type' | 'input' | 'attempts' | 'max_attempts'>

const safeError = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 1000)

export async function executeAgentTask(task: Task, agent: Agent, deps: ExecuteDeps): Promise<ExecuteOutcome> {
  const { store } = deps
  if (task.agent_id !== agent.id) throw new Error('task/agent mismatch')

  const runId = await store.startRun({ workspaceId: task.workspace_id, taskId: task.id, agentId: agent.id, characterId: task.character_id })
  const ctx: EffectContext = { workspaceId: task.workspace_id, characterId: task.character_id, agentId: agent.id, taskId: task.id, runId }
  const ev = (type: Parameters<AgentStore['event']>[2], payload: Record<string, unknown>) => store.event(task.workspace_id, runId, type, payload)

  const stop = async (status: 'failed' | 'budget_exceeded' | 'policy_blocked', error: string, retry: boolean, extra: Record<string, unknown> = {}): Promise<ExecuteOutcome> => {
    await ev(status === 'policy_blocked' ? 'policy_block' : 'error', { error, retry, ...extra })
    await store.finishRun(task.workspace_id, runId, { status, error })
    await store.failTask(task.id, error, retry && task.attempts < task.max_attempts)
    return { status, runId, error, retry }
  }

  // 1. Definition
  const def = taskDefinition(agent.role, task.type)
  if (!def) return stop('policy_blocked', `agent role ${agent.role} has no task type "${task.type}"`, false)

  // 2. Authorisation — every capability the task needs.
  for (const cap of def.capabilities) {
    const d = authorizeAgentAction(agent, cap, deps.agentsEnabled)
    if (!d.allowed) return stop('policy_blocked', d.reason, false, { capability: cap })
  }

  // 3. Input
  const input = def.input.safeParse(task.input)
  if (!input.success) return stop('failed', `invalid task input: ${z.prettifyError(input.error).slice(0, 500)}`, false)

  // 4. Budget and rate limits (before spending anything)
  const [spent, runs] = await Promise.all([store.spentTodayUsd(agent.id), store.runsToday(agent.id)])
  if (spent >= Number(agent.daily_budget_usd)) return stop('budget_exceeded', `daily budget $${agent.daily_budget_usd} reached ($${spent.toFixed(4)} spent)`, false)
  if (runs > agent.max_actions_per_day) return stop('budget_exceeded', `daily action limit ${agent.max_actions_per_day} reached`, false)

  // 5. Identity + prompt
  const identity = await store.loadIdentity(task.workspace_id, task.character_id)
  const agentDef = AGENT_DEFINITIONS[agent.role]
  const system = [
    buildCharacterSystemPrompt(identity),
    `## Your role: ${agentDef.name}`,
    ...agentDef.responsibilities.map(r => `- ${r}`),
    'You have no tools. Respond ONLY with the JSON object requested. Anything with real-world effect is reviewed by a human before it happens.',
  ].join('\n')
  const prompt = `${def.instructions}\n\nTask input:\n${JSON.stringify(input.data, null, 2)}`
  await ev('message', { taskType: task.type, promptChars: prompt.length, systemChars: system.length })

  // 6. Provider call
  let result
  try {
    const provider = typeof deps.text === 'function' ? deps.text() : deps.text
    result = await provider.generate({ system, prompt, schema: def.output, tier: def.tier })
  } catch (e) {
    if (e instanceof ProviderNotConfiguredError) return stop('failed', e.message, false)
    if (e instanceof ProviderRefusalError) return stop('policy_blocked', e.message, false)
    if (e instanceof ProviderOutputError) return stop('failed', e.message, true)
    return stop('failed', safeError(e), isRetryable(e))
  }

  await ev('tool_result', { provider: result.provider, model: result.model, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, costUsd: result.costUsd })

  // 7. Effects (fixed handler; side effects can only become approval requests)
  let applied: Record<string, unknown>
  try {
    applied = await def.apply(result.data, input.data, ctx, store)
  } catch (e) {
    await store.finishRun(task.workspace_id, runId, { status: 'failed', model: result.model, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, costUsd: result.costUsd, error: safeError(e) })
    await store.failTask(task.id, safeError(e), false)
    await ev('error', { stage: 'apply', error: safeError(e) })
    return { status: 'failed', runId, error: safeError(e), retry: false }
  }
  await ev('decision', { applied: Object.keys(applied) })

  // 8. Book-keeping
  if (result.costUsd > 0) await store.recordAiExpense(ctx, result.costUsd, result.model)
  await store.finishRun(task.workspace_id, runId, {
    status: 'succeeded', model: result.model, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens,
    costUsd: result.costUsd, output: applied as Json,
  })
  await store.completeTask(task.id, applied)
  return { status: 'succeeded', runId, result: applied }
}
