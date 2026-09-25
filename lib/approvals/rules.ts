import type { AgentApprovalsRow, WorkspaceRole } from '@/types/database'
import { hasRole } from '@/lib/auth/roles'

/** Who may decide an approval. Pure — unit tested. */
export function canDecide(a: Pick<AgentApprovalsRow, 'status' | 'risk_level' | 'action_type' | 'expires_at'>, role: WorkspaceRole, now = new Date()): { ok: true } | { ok: false; reason: string } {
  if (a.status !== 'AWAITING_APPROVAL') return { ok: false, reason: `approval is ${a.status}` }
  if (a.expires_at && Date.parse(a.expires_at) < now.getTime()) return { ok: false, reason: 'approval request has expired' }
  if (!hasRole(role, 'editor')) return { ok: false, reason: 'viewers cannot approve actions' }
  const adminOnly = a.risk_level === 'high' || ['change_social_credentials', 'financial_action', 'change_publishing_policy'].includes(a.action_type)
  if (adminOnly && !hasRole(role, 'admin')) return { ok: false, reason: 'high-risk actions need an admin or owner' }
  return { ok: true }
}
