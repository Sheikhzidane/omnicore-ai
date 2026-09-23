import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AGENT_CAPABILITIES, FORBIDDEN_CAPABILITIES, ROLE_CAPABILITIES, authorizeAgentAction, agentsGloballyEnabled } from '@/lib/agents/permissions'
import type { AgentRole } from '@/types/database'

const active = (role: AgentRole, autonomy: 'suggest_only' | 'approval_required' | 'autonomous_within_limits' = 'approval_required') =>
  ({ role, status: 'active' as const, autonomy })
const ROLES = Object.keys(ROLE_CAPABILITIES) as AgentRole[]

test('all nine roles exist', () => {
  assert.deepEqual(ROLES.sort(), ['analytics', 'ceo', 'community', 'content', 'creative_director', 'finance', 'growth', 'sales', 'social'])
})

test('no role can ever use a forbidden capability — at any autonomy level', () => {
  for (const role of ROLES) {
    for (const cap of FORBIDDEN_CAPABILITIES) {
      for (const autonomy of ['suggest_only', 'approval_required', 'autonomous_within_limits'] as const) {
        assert.equal(authorizeAgentAction(active(role, autonomy), cap, true).allowed, false, `${role}/${cap}/${autonomy}`)
      }
    }
  }
})

test('forbidden list covers code, infra, secrets and abuse', () => {
  for (const c of ['fs.write', 'git.push', 'db.ddl', 'db.rls.modify', 'db.migrations.modify', 'auth.modify', 'env.modify',
    'secrets.read', 'social_credentials.read', 'packages.modify', 'deploy.config.modify', 'billing.modify',
    'security.middleware.modify', 'abuse.mass_dm', 'abuse.fake_engagement', 'abuse.rate_limit_evasion']) {
    assert.ok((FORBIDDEN_CAPABILITIES as readonly string[]).includes(c), c)
  }
  for (const c of Object.keys(AGENT_CAPABILITIES)) {
    assert.ok(!(FORBIDDEN_CAPABILITIES as readonly string[]).includes(c), `${c} cannot be both allowed and forbidden`)
  }
})

test('unknown capabilities are denied by default', () => {
  assert.equal(authorizeAgentAction(active('ceo'), 'send_dm', true).allowed, false)
})

test('global kill switch and agent status gate everything', () => {
  assert.equal(authorizeAgentAction(active('content'), 'content.draft', false).allowed, false)
  assert.equal(authorizeAgentAction({ role: 'content', status: 'disabled', autonomy: 'approval_required' }, 'content.draft', true).allowed, false)
  assert.equal(authorizeAgentAction({ role: 'content', status: 'paused', autonomy: 'approval_required' }, 'content.draft', true).allowed, false)
  assert.equal(agentsGloballyEnabled({}), false)
  assert.equal(agentsGloballyEnabled({ AGENTS_ENABLED: 'true' }), true)
})

test('roles are least-privilege', () => {
  assert.equal(authorizeAgentAction(active('content'), 'content.publish', true).allowed, false, 'content agent cannot publish')
  assert.equal(authorizeAgentAction(active('community'), 'crm.send_outreach', true).allowed, false)
  assert.equal(authorizeAgentAction(active('finance'), 'content.draft', true).allowed, false)
})

test('side effects require human approval unless autonomous; suggest-only cannot act', () => {
  const pub = authorizeAgentAction(active('social'), 'content.publish', true)
  assert.deepEqual([pub.allowed, pub.requiresHumanApproval], [true, true])
  const auto = authorizeAgentAction(active('social', 'autonomous_within_limits'), 'content.publish', true)
  assert.deepEqual([auto.allowed, auto.requiresHumanApproval], [true, false])
  assert.equal(authorizeAgentAction(active('sales', 'suggest_only'), 'crm.send_outreach', true).allowed, false)
  const draft = authorizeAgentAction(active('content'), 'content.draft', true)
  assert.deepEqual([draft.allowed, draft.requiresHumanApproval], [true, false])
})
