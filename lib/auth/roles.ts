import type { WorkspaceRole } from '@/types/database'

// Mirrors private.role_rank() in supabase/migrations/20260923000000_tenancy.sql.
const RANK: Record<WorkspaceRole, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 }

export function hasRole(actual: WorkspaceRole | null | undefined, required: WorkspaceRole): boolean {
  return !!actual && RANK[actual] >= RANK[required]
}
