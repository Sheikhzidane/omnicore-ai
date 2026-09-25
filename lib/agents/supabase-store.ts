import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/types/database'
import type { CharacterIdentity } from '@/lib/characters/identity'
import type { AgentStore } from './store'

type Db = SupabaseClient<Database>

/**
 * AgentStore backed by Supabase (service role). One instance is bound to ONE
 * workspace: every read and write filters on that workspace_id, and any
 * effect whose context names a different workspace is refused. Agent-created
 * rows are always tagged with the run that produced them.
 */
export function createSupabaseAgentStore(db: Db, workspaceId: string): AgentStore {
  const guard = (ctx: { workspaceId: string }) => {
    if (ctx.workspaceId !== workspaceId) throw new Error('agent store: cross-workspace write refused')
  }
  const must = <T>(r: { data: T; error: { message: string } | null }, what: string): NonNullable<T> => {
    if (r.error) throw new Error(`${what}: ${r.error.message}`)
    if (r.data === null || r.data === undefined) throw new Error(`${what}: no data`)
    return r.data as NonNullable<T>
  }
  const today = () => new Date().toISOString().slice(0, 10)
  const startOfDay = () => `${today()}T00:00:00Z`

  return {
    async loadIdentity(ws, characterId) {
      guard({ workspaceId: ws })
      const [c, p, v, b, m] = await Promise.all([
        db.from('characters').select('id, name, status, ai_disclosure_mode, disclosure_text, min_audience_age, age_restricted')
          .eq('workspace_id', ws).eq('id', characterId).single(),
        db.from('character_profiles').select('display_name, description, niche, target_audience, personality, tone_of_voice, backstory, content_boundaries, language')
          .eq('workspace_id', ws).eq('character_id', characterId).maybeSingle(),
        db.from('character_visual_rules').select('appearance_description, style_keywords, color_palette, camera_style, prompt_prefix, negative_prompt, do_not_depict')
          .eq('workspace_id', ws).eq('character_id', characterId).maybeSingle(),
        db.from('character_brand_rules').select('rule_type, rule, priority, active')
          .eq('workspace_id', ws).eq('character_id', characterId).eq('active', true),
        // Canon only: agent-proposed memories never reach prompts until a human confirms them.
        db.from('character_memories').select('kind, content, importance, is_canon')
          .eq('workspace_id', ws).eq('character_id', characterId).eq('is_canon', true)
          .order('importance', { ascending: false }).limit(50),
      ])
      const identity: CharacterIdentity = {
        character: must(c, 'load character'),
        profile: p.data ?? null,
        visual: v.data ?? null,
        brandRules: b.data ?? [],
        memories: m.data ?? [],
      }
      return identity
    },

    async spentTodayUsd(agentId) {
      const r = await db.from('agent_runs').select('cost_usd').eq('workspace_id', workspaceId).eq('agent_id', agentId).gte('started_at', startOfDay())
      return must(r, 'agent spend').reduce((s, x) => s + Number(x.cost_usd), 0)
    },

    async runsToday(agentId) {
      const r = await db.from('agent_runs').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId).eq('agent_id', agentId).gte('started_at', startOfDay())
      if (r.error) throw new Error(`agent run count: ${r.error.message}`)
      return r.count ?? 0
    },

    async startRun(r) {
      guard(r)
      const row = must(await db.from('agent_runs').insert({ workspace_id: workspaceId, agent_task_id: r.taskId, agent_id: r.agentId, character_id: r.characterId }).select('id').single(), 'start run')
      await db.from('agents').update({ last_run_at: new Date().toISOString() }).eq('workspace_id', workspaceId).eq('id', r.agentId)
      return row.id
    },

    async event(ws, runId, type, payload) {
      guard({ workspaceId: ws })
      const last = await db.from('agent_run_events').select('seq').eq('workspace_id', ws).eq('agent_run_id', runId).order('seq', { ascending: false }).limit(1).maybeSingle()
      const seq = (last.data?.seq ?? 0) + 1
      const r = await db.from('agent_run_events').insert({ workspace_id: ws, agent_run_id: runId, seq, type, payload: payload as Json })
      if (r.error) throw new Error(`run event: ${r.error.message}`)
    },

    async finishRun(ws, runId, f) {
      guard({ workspaceId: ws })
      const r = await db.from('agent_runs').update({
        status: f.status, model: f.model ?? null, input_tokens: f.inputTokens ?? 0, output_tokens: f.outputTokens ?? 0,
        cost_usd: f.costUsd ?? 0, output: f.output ?? null, error: f.error ?? null, finished_at: new Date().toISOString(),
      }).eq('workspace_id', ws).eq('id', runId)
      if (r.error) throw new Error(`finish run: ${r.error.message}`)
    },

    async completeTask(taskId, result) {
      const r = await db.from('agent_tasks').update({ status: 'completed', result: result as Json, last_error: null }).eq('workspace_id', workspaceId).eq('id', taskId)
      if (r.error) throw new Error(`complete task: ${r.error.message}`)
    },

    async failTask(taskId, error, retry) {
      // claim_agent_tasks() only re-claims while attempts < max_attempts.
      const r = await db.from('agent_tasks').update({ status: retry ? 'queued' : 'failed', last_error: error.slice(0, 2000) }).eq('workspace_id', workspaceId).eq('id', taskId)
      if (r.error) throw new Error(`fail task: ${r.error.message}`)
    },

    async recordAiExpense(ctx, costUsd, model) {
      guard(ctx)
      // agent_runs.cost_usd holds the exact figure; the ledger row is rounded to cents.
      const r = await db.from('expenses').insert({
        workspace_id: workspaceId, character_id: ctx.characterId, category: 'ai_compute', vendor: model,
        amount_cents: Math.round(costUsd * 100), currency: 'USD', occurred_on: today(),
        description: `Agent run ${ctx.runId} ($${costUsd.toFixed(6)})`, agent_run_id: ctx.runId,
      })
      if (r.error) throw new Error(`ai expense: ${r.error.message}`)
    },

    async createIdeas(ctx, ideas) {
      guard(ctx)
      const rows = ideas.map(i => ({
        workspace_id: workspaceId, character_id: ctx.characterId, title: i.title, summary: i.summary, angle: i.angle,
        platforms: i.platforms, score: i.score, source: 'agent' as const, agent_run_id: ctx.runId,
      }))
      return must(await db.from('content_ideas').insert(rows).select('id'), 'create ideas').map(r => r.id)
    },

    async createCalendarSlots(ctx, slots, timezone) {
      guard(ctx)
      const rows = slots.map(s => ({
        workspace_id: workspaceId, character_id: ctx.characterId, platform: s.platform, slot_date: s.date,
        slot_time: s.time ?? null, timezone, note: s.note,
      }))
      return must(await db.from('content_calendar').insert(rows).select('id'), 'calendar slots').map(r => r.id)
    },

    async addContentVersion(ctx, contentItemId, f) {
      guard(ctx)
      const item = must(await db.from('content_items').select('id, current_version, status, character_id').eq('workspace_id', workspaceId).eq('id', contentItemId).single(), 'content item')
      if (item.character_id !== ctx.characterId) throw new Error('content item belongs to another character')
      if (!['draft', 'in_review', 'rejected'].includes(item.status)) throw new Error(`content item is ${item.status}; agents may only revise drafts`)
      const version = item.current_version + 1
      const ins = await db.from('content_versions').insert({
        workspace_id: workspaceId, content_item_id: contentItemId, version, caption: f.caption ?? null, script: f.script ?? null,
        hashtags: f.hashtags ?? [], image_prompt: f.imagePrompt ?? null, video_prompt: f.videoPrompt ?? null,
        metadata: (f.metadata ?? {}) as Json, created_by_type: 'agent', agent_run_id: ctx.runId,
      })
      if (ins.error) throw new Error(`content version: ${ins.error.message}`)
      // New text invalidates any earlier safety result and disclosure check.
      const up = await db.from('content_items').update({ current_version: version, safety_status: 'unchecked', disclosure_applied: false, status: 'draft' })
        .eq('workspace_id', workspaceId).eq('id', contentItemId).eq('current_version', item.current_version)
      if (up.error) throw new Error(`content item version bump: ${up.error.message}`)
      return version
    },

    async recordSafetyAssessment(ctx, contentItemId, a) {
      guard(ctx)
      // An agent may flag or block content; it can never mark it 'passed' —
      // that needs the rules engine + moderation (lib/content/safety.ts).
      const cur = must(await db.from('content_items').select('safety_report').eq('workspace_id', workspaceId).eq('id', contentItemId).eq('character_id', ctx.characterId).single(), 'content item')
      const report = { ...(cur.safety_report as Record<string, Json>), agent: { ...a, runId: ctx.runId, at: new Date().toISOString() } }
      const patch = a.status === 'passed' ? { safety_report: report as Json } : { safety_status: a.status, safety_report: report as Json }
      const r = await db.from('content_items').update(patch).eq('workspace_id', workspaceId).eq('id', contentItemId).eq('character_id', ctx.characterId)
      if (r.error) throw new Error(`safety assessment: ${r.error.message}`)
    },

    async proposeMemories(ctx, memories) {
      guard(ctx)
      const rows = memories.map(m => ({
        workspace_id: workspaceId, character_id: ctx.characterId, kind: m.kind as Database['public']['Tables']['character_memories']['Row']['kind'],
        content: m.content, source: 'agent' as const, is_canon: false, agent_run_id: ctx.runId,
      }))
      return must(await db.from('character_memories').insert(rows).select('id'), 'propose memories').map(r => r.id)
    },

    async createInternalTasks(ctx, tasks) {
      guard(ctx)
      const roles = [...new Set(tasks.map(t => t.role))] as Database['public']['Tables']['agents']['Row']['role'][]
      const agents = must(await db.from('agents').select('id, role').eq('workspace_id', workspaceId).eq('character_id', ctx.characterId).in('role', roles), 'agents')
      const byRole = new Map(agents.map(a => [a.role as string, a.id]))
      // Delegated work waits for a human to queue it ('proposed'), so agents cannot chain themselves.
      const rows = tasks.filter(t => byRole.has(t.role)).map(t => ({
        workspace_id: workspaceId, character_id: ctx.characterId, agent_id: byRole.get(t.role)!, parent_task_id: ctx.taskId,
        created_by_agent_id: ctx.agentId, type: t.type, title: t.title, input: t.input as Json, status: 'proposed' as const,
      }))
      if (rows.length === 0) return []
      return must(await db.from('agent_tasks').insert(rows).select('id'), 'internal tasks').map(r => r.id)
    },

    async createReplySuggestions(ctx, replies) {
      guard(ctx)
      const ids = replies.map(r => r.engagementItemId)
      const items = must(await db.from('engagement_items').select('id').eq('workspace_id', workspaceId).eq('character_id', ctx.characterId).in('id', ids), 'engagement items')
      const valid = new Set(items.map(i => i.id))
      const rows = replies.filter(r => valid.has(r.engagementItemId)).map(r => ({
        workspace_id: workspaceId, engagement_item_id: r.engagementItemId, body: r.body, is_ai_generated: true, status: 'suggested' as const, agent_run_id: ctx.runId,
      }))
      if (rows.length === 0) return []
      return must(await db.from('engagement_replies').insert(rows).select('id'), 'reply suggestions').map(r => r.id)
    },

    async updateLeadFit(ctx, leadId, fit) {
      guard(ctx)
      const r = await db.from('leads').update({
        fit_score: fit.fitScore, fit_reasoning: fit.reasoning, fit_signals: { redFlags: fit.redFlags, angle: fit.angle, runId: ctx.runId } as Json,
      }).eq('workspace_id', workspaceId).eq('id', leadId)
      if (r.error) throw new Error(`lead fit: ${r.error.message}`)
    },

    async requestApproval(ctx, req) {
      guard(ctx)
      // One approval per (task, action): a retried task returns the existing request.
      const key = `agent-task:${ctx.taskId}:${req.actionType}:${req.entityId ?? ''}`
      const existing = await db.from('agent_approvals').select('id').eq('workspace_id', workspaceId).eq('idempotency_key', key).maybeSingle()
      if (existing.data) return existing.data.id
      const row = must(await db.from('agent_approvals').insert({
        workspace_id: workspaceId, character_id: ctx.characterId, action_type: req.actionType, entity_type: req.entityType,
        entity_id: req.entityId ?? null, title: req.title.slice(0, 300), summary: req.summary?.slice(0, 4000) ?? null,
        payload: req.payload as Json, risk_level: req.riskLevel, status: 'AWAITING_APPROVAL', requested_by_type: 'agent',
        requested_by_agent_id: ctx.agentId, agent_run_id: ctx.runId, idempotency_key: key,
      }).select('id').single(), 'request approval')
      return row.id
    },
  }
}
