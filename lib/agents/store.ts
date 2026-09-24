import type { CharacterIdentity } from '@/lib/characters/identity'
import type { Json } from '@/types/database'

/**
 * Everything an agent run can do to the world. The executor only ever calls
 * these methods; the Supabase implementation (supabase-store.ts) scopes every
 * write to ctx.workspaceId. There is intentionally no method for files,
 * SQL, shell, git, env, credentials or policy changes.
 */

export interface EffectContext {
  workspaceId: string
  characterId: string
  agentId: string
  taskId: string
  runId: string
}

export interface ApprovalRequest {
  actionType: 'publish_content' | 'send_external_message' | 'brand_outreach' | 'engagement_reply' | 'memory_update' | 'agent_task'
  entityType: string
  entityId?: string
  title: string
  summary?: string
  riskLevel: 'low' | 'medium' | 'high'
  payload: Record<string, unknown>
}

export interface VersionFields {
  caption?: string
  script?: string
  hashtags?: string[]
  imagePrompt?: string
  videoPrompt?: string
  metadata?: Record<string, unknown>
}

export interface RunStart {
  workspaceId: string
  taskId: string
  agentId: string
  characterId: string
}

export interface RunFinish {
  status: 'succeeded' | 'failed' | 'budget_exceeded' | 'policy_blocked'
  model?: string
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  output?: Json
  error?: string
}

export interface AgentStore {
  loadIdentity(workspaceId: string, characterId: string): Promise<CharacterIdentity>
  spentTodayUsd(agentId: string): Promise<number>
  runsToday(agentId: string): Promise<number>

  startRun(r: RunStart): Promise<string>
  event(workspaceId: string, runId: string, type: 'message' | 'tool_call' | 'tool_result' | 'decision' | 'policy_block' | 'error', payload: Record<string, unknown>): Promise<void>
  finishRun(workspaceId: string, runId: string, f: RunFinish): Promise<void>
  completeTask(taskId: string, result: Record<string, unknown>): Promise<void>
  /** retry=true puts the task back in the queue (attempts permitting). */
  failTask(taskId: string, error: string, retry: boolean): Promise<void>
  recordAiExpense(ctx: EffectContext, costUsd: number, model: string): Promise<void>

  // ── effects ──
  createIdeas(ctx: EffectContext, ideas: { title: string; summary: string; angle: string; platforms: string[]; score: number }[]): Promise<string[]>
  createCalendarSlots(ctx: EffectContext, slots: { date: string; time?: string; platform: string; note: string }[], timezone: string): Promise<string[]>
  addContentVersion(ctx: EffectContext, contentItemId: string, fields: VersionFields): Promise<number>
  recordSafetyAssessment(ctx: EffectContext, contentItemId: string, a: { status: 'passed' | 'flagged' | 'blocked'; reasons: string[]; categories: string[] }): Promise<void>
  proposeMemories(ctx: EffectContext, memories: { kind: string; content: string }[]): Promise<string[]>
  createInternalTasks(ctx: EffectContext, tasks: { role: string; type: string; title: string; input: Record<string, unknown> }[]): Promise<string[]>
  createReplySuggestions(ctx: EffectContext, replies: { engagementItemId: string; body: string }[]): Promise<string[]>
  updateLeadFit(ctx: EffectContext, leadId: string, fit: { fitScore: number; reasoning: string; redFlags: string[]; angle: string }): Promise<void>
  requestApproval(ctx: EffectContext, req: ApprovalRequest): Promise<string>
}
