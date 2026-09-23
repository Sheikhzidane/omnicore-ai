import type { AgentRole, AgentRow } from '@/types/database'
import { PROHIBITED_AUTOMATION } from '@/lib/safety/prohibited'

/**
 * Character-agent permission model (docs/AGENT_PERMISSIONS.md).
 *
 * Agents act ONLY through capabilities granted here. Anything touching code,
 * infrastructure, credentials or security is in FORBIDDEN_CAPABILITIES and can
 * never be granted — not by role, config, autonomy level or owner request.
 * The executor (later phase) must call authorizeAgentAction() before every
 * tool call and write the outcome to agent_run_events / audit_log.
 */

export const AGENT_CAPABILITIES = {
  'content.ideate':          { sideEffect: false, description: 'Generate content ideas' },
  'content.draft':           { sideEffect: false, description: 'Draft captions/scripts (saved as drafts)' },
  'content.review':          { sideEffect: false, description: 'Review drafts against brand rules and policy' },
  'content.schedule':        { sideEffect: true,  description: 'Queue APPROVED content for publishing' },
  'content.publish':         { sideEffect: true,  description: 'Publish through a connected, approved adapter' },
  'community.draft_reply':   { sideEffect: false, description: 'Draft replies to comments on own posts' },
  'analytics.read':          { sideEffect: false, description: 'Read metrics from connected adapters' },
  'analytics.summarize':     { sideEffect: false, description: 'Summarise performance' },
  'strategy.recommend':      { sideEffect: false, description: 'Recommend strategy / experiments' },
  'tasks.create_internal':   { sideEffect: false, description: 'Create internal tasks for other agents' },
  'crm.research_brand':      { sideEffect: false, description: 'Research brand prospects' },
  'crm.score_fit':           { sideEffect: false, description: 'Score brand/character fit' },
  'crm.draft_outreach':      { sideEffect: false, description: 'Draft outreach (never sends)' },
  'crm.send_outreach':       { sideEffect: true,  description: 'Send an APPROVED outreach email' },
  'finance.read_revenue':    { sideEffect: false, description: 'Read the revenue ledger' },
  'finance.draft_invoice_reminder': { sideEffect: false, description: 'Draft an invoice reminder' },
} as const

export type AgentCapability = keyof typeof AGENT_CAPABILITIES

/** Never grantable. Includes every prohibited automation behaviour. */
export const FORBIDDEN_CAPABILITIES = [
  'fs.write', 'fs.read', 'shell.exec', 'git.commit', 'git.push',
  'db.raw_sql', 'db.ddl', 'db.migrations.modify', 'db.rls.modify',
  'auth.modify', 'security.middleware.modify', 'env.read', 'env.modify',
  'secrets.read', 'credentials.read', 'social_credentials.read',
  'packages.modify', 'lockfile.modify', 'deploy.config.modify',
  'github.credentials.read', 'billing.modify', 'agents.permissions.modify',
  ...Object.keys(PROHIBITED_AUTOMATION).map(k => `abuse.${k}`),
] as const

export const ROLE_CAPABILITIES: Record<AgentRole, readonly AgentCapability[]> = {
  ceo:               ['tasks.create_internal', 'analytics.read', 'analytics.summarize', 'strategy.recommend'],
  creative_director: ['content.review', 'content.ideate', 'strategy.recommend'],
  content:           ['content.ideate', 'content.draft'],
  social:            ['content.schedule', 'content.publish', 'analytics.read'],
  community:         ['community.draft_reply'],
  growth:            ['analytics.read', 'analytics.summarize', 'strategy.recommend', 'tasks.create_internal'],
  sales:             ['crm.research_brand', 'crm.score_fit', 'crm.draft_outreach', 'crm.send_outreach'],
  analytics:         ['analytics.read', 'analytics.summarize'],
  finance:           ['finance.read_revenue', 'finance.draft_invoice_reminder'],
}

export const ROLE_LABELS: Record<AgentRole, string> = {
  ceo: 'CEO', creative_director: 'Creative Director', content: 'Content', social: 'Social',
  community: 'Community', growth: 'Growth', sales: 'Sales', analytics: 'Analytics', finance: 'Finance',
}

export type AgentDecision =
  | { allowed: true; requiresHumanApproval: boolean; reason: string }
  | { allowed: false; requiresHumanApproval: false; reason: string }

export function isKnownCapability(c: string): c is AgentCapability {
  return Object.prototype.hasOwnProperty.call(AGENT_CAPABILITIES, c)
}

/**
 * The single authorisation point for character-agent actions.
 * `agentsEnabled` is the global kill switch (AGENTS_ENABLED env, default off).
 */
export function authorizeAgentAction(
  agent: Pick<AgentRow, 'role' | 'status' | 'autonomy'>,
  capability: string,
  agentsEnabled: boolean,
): AgentDecision {
  const deny = (reason: string): AgentDecision => ({ allowed: false, requiresHumanApproval: false, reason })
  if ((FORBIDDEN_CAPABILITIES as readonly string[]).includes(capability)) return deny(`${capability} is permanently forbidden for agents`)
  if (!isKnownCapability(capability)) return deny(`unknown capability ${capability} (default deny)`)
  if (!agentsEnabled) return deny('agents are globally disabled (AGENTS_ENABLED is not "true")')
  if (agent.status !== 'active') return deny(`agent is ${agent.status}`)
  if (!ROLE_CAPABILITIES[agent.role].includes(capability)) return deny(`role ${agent.role} does not have ${capability}`)
  if (agent.autonomy === 'suggest_only' && AGENT_CAPABILITIES[capability].sideEffect) {
    return deny('suggest-only agents cannot perform side effects')
  }
  const sideEffect = AGENT_CAPABILITIES[capability].sideEffect
  const requiresHumanApproval = sideEffect && agent.autonomy !== 'autonomous_within_limits'
  return { allowed: true, requiresHumanApproval, reason: requiresHumanApproval ? 'side effect requires human approval' : 'allowed' }
}

export function agentsGloballyEnabled(env: Record<string, string | undefined>): boolean {
  return env.AGENTS_ENABLED === 'true'
}
