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
  'approvals.request':       { sideEffect: false, description: 'Ask a human to approve a sensitive action' },
  'tasks.create_internal':   { sideEffect: false, description: 'Create internal tasks for other agents' },
  'character.propose_memory':{ sideEffect: false, description: 'Propose a (non-canon) character memory' },
  'trends.research':         { sideEffect: false, description: 'Analyse owner-supplied trend signals and own analytics' },
  'content.ideate':          { sideEffect: false, description: 'Generate content ideas' },
  'content.plan':            { sideEffect: false, description: 'Plan calendar slots' },
  'content.draft':           { sideEffect: false, description: 'Draft captions/scripts (saved as drafts)' },
  'content.generate_media_prompt': { sideEffect: false, description: 'Write image/video generation prompts' },
  'content.generate_media':  { sideEffect: false, description: 'Generate media via a configured provider (budgeted)' },
  'content.review':          { sideEffect: false, description: 'Review drafts against brand rules and policy' },
  'safety.assess':           { sideEffect: false, description: 'Run safety/policy assessment on content' },
  'content.schedule':        { sideEffect: true,  description: 'Queue APPROVED content for publishing' },
  'content.publish':         { sideEffect: true,  description: 'Publish through a connected, approved adapter' },
  'community.draft_reply':   { sideEffect: false, description: 'Draft replies to comments on own posts' },
  'community.send_reply':    { sideEffect: true,  description: 'Send an APPROVED reply' },
  'analytics.read':          { sideEffect: false, description: 'Read metrics from connected adapters' },
  'analytics.summarize':     { sideEffect: false, description: 'Summarise performance' },
  'strategy.recommend':      { sideEffect: false, description: 'Recommend strategy / experiments' },
  'crm.research_brand':      { sideEffect: false, description: 'Research brand prospects (owner-supplied info)' },
  'crm.score_fit':           { sideEffect: false, description: 'Score brand/character fit' },
  'crm.draft_outreach':      { sideEffect: false, description: 'Draft outreach (never sends)' },
  'crm.send_outreach':       { sideEffect: true,  description: 'Send an APPROVED outreach email' },
  'finance.read_revenue':    { sideEffect: false, description: 'Read the revenue/expense ledger' },
  'finance.summarize':       { sideEffect: false, description: 'Summarise profit/ROI' },
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
  ceo:               ['approvals.request', 'tasks.create_internal', 'analytics.read', 'analytics.summarize', 'strategy.recommend', 'finance.read_revenue'],
  character:         ['approvals.request', 'character.propose_memory', 'content.review'],
  trend_research:    ['approvals.request', 'trends.research', 'content.ideate', 'analytics.read'],
  creative_director: ['approvals.request', 'content.review', 'content.ideate', 'strategy.recommend'],
  content_planner:   ['approvals.request', 'content.ideate', 'content.plan', 'tasks.create_internal'],
  copywriter:        ['approvals.request', 'content.draft'],
  image_prompt:      ['approvals.request', 'content.generate_media_prompt', 'content.generate_media'],
  video_script:      ['approvals.request', 'content.draft', 'content.generate_media_prompt'],
  quality:           ['approvals.request', 'content.review'],
  safety:            ['approvals.request', 'safety.assess'],
  publishing:        ['approvals.request', 'content.schedule', 'content.publish', 'analytics.read'],
  community:         ['approvals.request', 'community.draft_reply', 'community.send_reply'],
  growth_analyst:    ['approvals.request', 'analytics.read', 'analytics.summarize', 'strategy.recommend', 'tasks.create_internal'],
  sales:             ['approvals.request', 'crm.research_brand', 'crm.score_fit', 'crm.draft_outreach', 'crm.send_outreach'],
  finance_analyst:   ['approvals.request', 'finance.read_revenue', 'finance.summarize', 'finance.draft_invoice_reminder'],
}

export const ROLE_LABELS: Record<AgentRole, string> = {
  ceo: 'CEO / Strategy', character: 'Character', trend_research: 'Trend Research', creative_director: 'Creative Director',
  content_planner: 'Content Planner', copywriter: 'Copywriter', image_prompt: 'Image Prompt', video_script: 'Video Script',
  quality: 'Quality', safety: 'Safety', publishing: 'Publishing', community: 'Community',
  growth_analyst: 'Growth Analyst', sales: 'Sales', finance_analyst: 'Finance Analyst',
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
