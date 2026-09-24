import { test } from 'node:test'
import assert from 'node:assert/strict'
import { executeAgentTask } from '@/lib/agents/executor'
import { AGENT_DEFINITIONS } from '@/lib/agents/definitions'
import { ROLE_CAPABILITIES } from '@/lib/agents/permissions'
import type { AgentStore, ApprovalRequest, EffectContext, RunFinish } from '@/lib/agents/store'
import { createMockTextProvider } from '@/lib/ai/mock'
import { ProviderError, ProviderNotConfiguredError, ProviderRefusalError } from '@/lib/ai/errors'
import type { TextProvider } from '@/lib/ai/types'
import type { AgentRole } from '@/types/database'

const WS = '11111111-1111-4111-8111-111111111111'
const CH = '22222222-2222-4222-8222-222222222222'
const ITEM = '33333333-3333-4333-8333-333333333333'
const ACCT = '44444444-4444-4444-8444-444444444444'

function memoryStore(overrides: Partial<{ spent: number; runs: number }> = {}) {
  const log = {
    runs: [] as { id: string; finish?: RunFinish }[], events: [] as { type: string; payload: Record<string, unknown> }[],
    ideas: [] as unknown[], versions: [] as unknown[], approvals: [] as ApprovalRequest[], tasks: [] as { id: string; status: string; error?: string; retry?: boolean }[],
    expenses: [] as number[], replies: [] as unknown[], memories: [] as unknown[], safety: [] as unknown[],
  }
  const store: AgentStore = {
    async loadIdentity() {
      return {
        character: { id: CH, name: 'Nova', status: 'active', ai_disclosure_mode: 'always', disclosure_text: 'AI-generated virtual character', min_audience_age: 13, age_restricted: false },
        profile: null, visual: null, brandRules: [], memories: [],
      }
    },
    async spentTodayUsd() { return overrides.spent ?? 0 },
    async runsToday() { return overrides.runs ?? 1 },
    async startRun() { const id = `run-${log.runs.length + 1}`; log.runs.push({ id }); return id },
    async event(_w, _r, type, payload) { log.events.push({ type, payload }) },
    async finishRun(_w, runId, f) { log.runs.find(r => r.id === runId)!.finish = f },
    async completeTask(id) { log.tasks.push({ id, status: 'completed' }) },
    async failTask(id, error, retry) { log.tasks.push({ id, status: 'failed', error, retry }) },
    async recordAiExpense(_c, cost) { log.expenses.push(cost) },
    async createIdeas(_c, ideas) { log.ideas.push(...ideas); return ideas.map((_, i) => `idea-${i}`) },
    async createCalendarSlots(_c, slots) { return slots.map((_, i) => `slot-${i}`) },
    async addContentVersion(_c, id, f) { log.versions.push({ id, ...f }); return log.versions.length },
    async recordSafetyAssessment(_c, id, a) { log.safety.push({ id, ...a }) },
    async proposeMemories(_c, m) { log.memories.push(...m); return m.map((_, i) => `mem-${i}`) },
    async createInternalTasks(_c, t) { return t.map((_, i) => `task-${i}`) },
    async createReplySuggestions(_c, r) { log.replies.push(...r); return r.map((_, i) => `reply-${i}`) },
    async updateLeadFit() {},
    async requestApproval(_c: EffectContext, req) { log.approvals.push(req); return `approval-${log.approvals.length}` },
  }
  return { store, log }
}

const agent = (role: AgentRole, over: Record<string, unknown> = {}) => ({
  id: 'agent-1', role, status: 'active' as const, autonomy: 'approval_required' as const, daily_budget_usd: 1, max_actions_per_day: 20, ...over,
})
const task = (type: string, input: unknown, over: Record<string, unknown> = {}) => ({
  id: 'task-1', workspace_id: WS, character_id: CH, agent_id: 'agent-1', type, input: input as never, attempts: 1, max_attempts: 3, ...over,
})

const ideasProvider = createMockTextProvider(() => ({ ideas: [{ title: 'Idea', summary: 'S', angle: 'A', platforms: ['instagram'], score: 70 }] }))

test('every agent definition only declares capabilities its role holds', () => {
  for (const [role, def] of Object.entries(AGENT_DEFINITIONS)) {
    for (const [type, t] of Object.entries(def.tasks)) {
      for (const cap of t.capabilities) {
        assert.ok(ROLE_CAPABILITIES[role as AgentRole].includes(cap), `${role}.${type} uses ${cap} which ${role} does not hold`)
      }
    }
    assert.ok(def.responsibilities.length > 0 && Object.keys(def.tasks).length > 0, `${role} must define responsibilities and tasks`)
  }
  assert.equal(Object.keys(AGENT_DEFINITIONS).length, 15)
})

test('success: validated output becomes store writes; run, cost and events are logged', async () => {
  const { store, log } = memoryStore()
  const out = await executeAgentTask(task('generate_ideas', { count: 1 }), agent('content_planner'), { store, text: ideasProvider, agentsEnabled: true })
  assert.equal(out.status, 'succeeded')
  assert.equal(log.ideas.length, 1)
  assert.equal(log.runs[0].finish?.status, 'succeeded')
  assert.equal(log.expenses[0], 0.001)
  assert.deepEqual(log.tasks, [{ id: 'task-1', status: 'completed' }])
  assert.ok(log.events.some(e => e.type === 'tool_result'))
})

test('global kill switch blocks every run before any provider call', async () => {
  const { store, log } = memoryStore()
  let called = false
  const provider: TextProvider = { id: 'spy', async generate() { called = true; throw new Error('should not be called') } }
  const out = await executeAgentTask(task('generate_ideas', { count: 1 }), agent('content_planner'), { store, text: provider, agentsEnabled: false })
  assert.equal(out.status, 'policy_blocked')
  assert.equal(called, false)
  assert.equal(log.tasks[0].retry, false)
})

test('an agent cannot run a task type outside its role', async () => {
  const { store } = memoryStore()
  const out = await executeAgentTask(task('prepare_publish', {}), agent('copywriter'), { store, text: ideasProvider, agentsEnabled: true })
  assert.equal(out.status, 'policy_blocked')
})

test('disabled or suggest-only agents cannot perform side-effect tasks', async () => {
  const { store } = memoryStore()
  const input = { contentItemId: ITEM, socialAccountId: ACCT, scheduledFor: '2026-10-01T10:00:00Z' }
  assert.equal((await executeAgentTask(task('prepare_publish', input), agent('publishing', { status: 'disabled' }), { store, text: ideasProvider, agentsEnabled: true })).status, 'policy_blocked')
  assert.equal((await executeAgentTask(task('prepare_publish', input), agent('publishing', { autonomy: 'suggest_only' }), { store, text: ideasProvider, agentsEnabled: true })).status, 'policy_blocked')
})

test('publishing agent can only REQUEST approval — it never publishes', async () => {
  const { store, log } = memoryStore()
  const provider = createMockTextProvider(() => ({ rationale: 'Ready and on brand' }))
  const input = { contentItemId: ITEM, socialAccountId: ACCT, scheduledFor: '2026-10-01T10:00:00Z' }
  const out = await executeAgentTask(task('prepare_publish', input), agent('publishing'), { store, text: provider, agentsEnabled: true })
  assert.equal(out.status, 'succeeded')
  assert.equal(log.approvals.length, 1)
  assert.equal(log.approvals[0].actionType, 'publish_content')
  assert.deepEqual(log.approvals[0].payload, input)
})

test('sales outreach is drafted into an approval request, never sent', async () => {
  const { store, log } = memoryStore()
  const provider = createMockTextProvider(() => ({ subject: 'Partnership idea', body: 'Hi — Nova is an AI virtual character…' }))
  const out = await executeAgentTask(task('draft_outreach', { leadId: ITEM, contactId: ACCT }), agent('sales'), { store, text: provider, agentsEnabled: true })
  assert.equal(out.status, 'succeeded')
  assert.equal(log.approvals[0].actionType, 'brand_outreach')
})

test('budget and daily action limits stop runs before spending', async () => {
  let called = false
  const provider: TextProvider = { id: 'spy', async generate() { called = true; throw new Error('no') } }
  const over = memoryStore({ spent: 1.5 })
  assert.equal((await executeAgentTask(task('generate_ideas', { count: 1 }), agent('content_planner'), { store: over.store, text: provider, agentsEnabled: true })).status, 'budget_exceeded')
  const busy = memoryStore({ runs: 21 })
  assert.equal((await executeAgentTask(task('generate_ideas', { count: 1 }), agent('content_planner'), { store: busy.store, text: provider, agentsEnabled: true })).status, 'budget_exceeded')
  assert.equal(called, false)
})

test('invalid input fails without retry; malformed model output fails with retry', async () => {
  const bad = memoryStore()
  const r1 = await executeAgentTask(task('write_caption', { contentItemId: 'not-a-uuid' }), agent('copywriter'), { store: bad.store, text: ideasProvider, agentsEnabled: true })
  assert.equal(r1.status, 'failed')
  assert.equal(bad.log.tasks[0].retry, false)

  const garbage: TextProvider = { id: 'g', async generate(req) { req.schema!.parse({ nope: true }); throw new Error('unreachable') } }
  const r2 = memoryStore()
  const out = await executeAgentTask(task('generate_ideas', { count: 1 }), agent('content_planner'), { store: r2.store, text: garbage, agentsEnabled: true })
  assert.equal(out.status, 'failed')
})

test('transient provider errors retry; refusals and missing config do not', async () => {
  const cases: [Error, string, boolean][] = [
    [new ProviderError('429', true, 429), 'failed', true],
    [new ProviderError('400', false, 400), 'failed', false],
    [new ProviderRefusalError('anthropic', 'cyber'), 'policy_blocked', false],
    [new ProviderNotConfiguredError('text generation', ['ANTHROPIC_API_KEY']), 'failed', false],
  ]
  for (const [err, status, retry] of cases) {
    const { store, log } = memoryStore()
    const provider: TextProvider = { id: 'x', async generate() { throw err } }
    const out = await executeAgentTask(task('generate_ideas', { count: 1 }), agent('content_planner'), { store, text: provider, agentsEnabled: true })
    assert.equal(out.status, status, err.message)
    assert.equal(log.tasks[0].retry, retry, err.message)
  }
})

test('retries stop once max_attempts is reached', async () => {
  const { store, log } = memoryStore()
  const provider: TextProvider = { id: 'x', async generate() { throw new ProviderError('503', true, 503) } }
  await executeAgentTask(task('generate_ideas', { count: 1 }, { attempts: 3, max_attempts: 3 }), agent('content_planner'), { store, text: provider, agentsEnabled: true })
  assert.equal(log.tasks[0].retry, false)
})

test('community replies are suggestions only; skipped items are dropped', async () => {
  const { store, log } = memoryStore()
  const provider = createMockTextProvider(() => ({ replies: [{ engagementItemId: ITEM, body: 'Thank you!', skip: false }, { engagementItemId: ACCT, body: '', skip: true }] }))
  await executeAgentTask(task('suggest_replies', { items: [{ engagementItemId: ITEM, body: 'love it' }, { engagementItemId: ACCT, body: 'spam' }] }), agent('community'), { store, text: provider, agentsEnabled: true })
  assert.equal(log.replies.length, 1)
  assert.equal(log.approvals.length, 0, 'suggesting a reply does not request sending')
})

test('the agent store exposes no code/infra/secret operations', () => {
  const { store } = memoryStore()
  const forbidden = /file|fs|sql|ddl|shell|exec|git|env|secret|credential|token|policy|migration|deploy|package/i
  const offending = Object.keys(store).filter(k => forbidden.test(k))
  assert.deepEqual(offending, [])
})
