/**
 * Supabase Database type.
 *
 * Mirrors the schema created by `supabase/migrations/` (see
 * supabase/migrations/README.md). Kept in the shape produced by
 * `supabase gen types typescript`, so it can be replaced by generated output
 * once a project is linked — tests/db/schema-types.test.mjs checks that every
 * table declared here exists in the migrated schema with the same columns.
 *
 * Tables used only by the legacy ops scripts (scripts/*.mjs, plain JS) are
 * intentionally absent: those scripts are untyped and disabled by default.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

type Timestamps = { created_at: string; updated_at: string }

// ── Legacy ops tables ────────────────────────────────────────────────────────

export type TodoComment = {
  agent: string
  text: string
  at: string
}

export type TodoRow = Timestamps & {
  id: string
  title: string
  description: string | null
  status: 'proposed' | 'pending' | 'in_progress' | 'completed' | 'failed' | 'blocked' | 'vetoed'
  priority: 'low' | 'medium' | 'high' | 'critical'
  assigned_agent: string | null
  is_boss: boolean
  deadline: string | null
  comments: TodoComment[]
  retry_count: number
  metadata: Json | null
  parent_task_id: string | null
  task_category: 'db' | 'ui' | 'infra' | 'analysis' | 'other'
}

export type GodStatusRow = {
  id: number
  thought: string | null
  meta: Json | null
  intent: Json | null
  updated_at: string
}

export type TraceRow = {
  id: string
  task_id: string | null
  agent_name: string | null
  tool_name: string
  input_summary: string | null
  result_summary: string | null
  duration_ms: number | null
  is_error: boolean
  created_at: string
}

export type SubscriberRow = {
  id: string
  email: string
  source: string | null
  referrer: string | null
  confirmed: boolean
  unsubscribed_at: string | null
  created_at: string
}

// ── Tenancy ──────────────────────────────────────────────────────────────────

export type WorkspaceRole = 'owner' | 'admin' | 'editor' | 'viewer'

export type WorkspaceRow = Timestamps & {
  id: string
  name: string
  owner_id: string
}

export type WorkspaceMemberRow = Timestamps & {
  workspace_id: string
  user_id: string
  role: WorkspaceRole
}

export type AuditLogRow = {
  id: string
  workspace_id: string | null
  actor_type: 'user' | 'agent' | 'system'
  actor_id: string | null
  action: string
  entity_type: string | null
  entity_id: string | null
  outcome: 'success' | 'denied' | 'error'
  details: Json
  created_at: string
}

// ── Safety foundations ───────────────────────────────────────────────────────

export type SocialPlatform = 'instagram' | 'tiktok' | 'youtube' | 'x'

export type ContentPolicyRow = Timestamps & {
  id: string
  workspace_id: string
  name: string
  version: number
  is_default: boolean
  rules: Json
  created_by: string | null
}

export type CharacterRow = Timestamps & {
  id: string
  workspace_id: string
  name: string
  slug: string
  status: 'draft' | 'active' | 'paused' | 'archived'
  ai_disclosure_mode: 'always' | 'bio_and_posts' | 'bio_only'
  disclosure_text: string
  approval_mode: 'human_required' | 'auto_low_risk'
  min_audience_age: number
  age_restricted: boolean
  depicts_real_person: boolean
  consent_evidence_path: string | null
  content_policy_id: string | null
  created_by: string | null
}

export type PlatformPublishingPolicyRow = Timestamps & {
  id: string
  workspace_id: string
  platform: SocialPlatform
  publishing_enabled: boolean
  requires_human_approval: boolean
  max_posts_per_day: number
  min_minutes_between_posts: number
  ai_label_required: boolean
  sponsored_disclosure_required: boolean
}

// ── Character agent engine ───────────────────────────────────────────────────

export type AgentRole =
  | 'ceo' | 'creative_director' | 'content' | 'social' | 'community'
  | 'growth' | 'sales' | 'analytics' | 'finance'

export type AgentRow = Timestamps & {
  id: string
  workspace_id: string
  character_id: string
  role: AgentRole
  name: string
  status: 'disabled' | 'active' | 'paused'
  autonomy: 'suggest_only' | 'approval_required' | 'autonomous_within_limits'
  config: Json
  daily_budget_usd: number
  max_actions_per_day: number
  last_run_at: string | null
}

export type AgentTaskRow = Timestamps & {
  id: string
  workspace_id: string
  character_id: string
  agent_id: string
  parent_task_id: string | null
  created_by_agent_id: string | null
  created_by_user: string | null
  type: string
  title: string
  input: Json
  priority: 'low' | 'medium' | 'high' | 'critical'
  status: 'proposed' | 'pending' | 'queued' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled'
  requires_approval: boolean
  approved_by: string | null
  approved_at: string | null
  scheduled_for: string | null
  attempts: number
  max_attempts: number
  last_error: string | null
  result: Json | null
  idempotency_key: string | null
}

export type AgentRunRow = {
  id: string
  workspace_id: string
  agent_task_id: string
  agent_id: string
  character_id: string
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'budget_exceeded' | 'policy_blocked'
  model: string | null
  input_tokens: number
  output_tokens: number
  cost_usd: number
  output: Json | null
  error: string | null
  started_at: string
  finished_at: string | null
  created_at: string
}

export type AgentRunEventRow = {
  id: string
  workspace_id: string
  agent_run_id: string
  seq: number
  type: 'message' | 'tool_call' | 'tool_result' | 'decision' | 'policy_block' | 'error'
  payload: Json
  created_at: string
}

// ── Helpers ──────────────────────────────────────────────────────────────────

type Table<Row, Required extends keyof Row> = {
  Row: Row
  Insert: Pick<Row, Required> & Partial<Omit<Row, Required>>
  Update: Partial<Row>
  Relationships: []
}

export interface Database {
  __InternalSupabase: { PostgrestVersion: '12' }
  public: {
    Tables: {
      todos:       Table<TodoRow, 'title'>
      god_status:  Table<GodStatusRow, 'id'>
      traces:      Table<TraceRow, 'tool_name'>
      subscribers: Table<SubscriberRow, 'email'>
      workspaces:        Table<WorkspaceRow, 'name' | 'owner_id'>
      workspace_members: Table<WorkspaceMemberRow, 'workspace_id' | 'user_id' | 'role'>
      audit_log:         Table<AuditLogRow, 'actor_type' | 'action'>
      content_policies:  Table<ContentPolicyRow, 'workspace_id' | 'name'>
      characters:        Table<CharacterRow, 'workspace_id' | 'name' | 'slug'>
      platform_publishing_policies: Table<PlatformPublishingPolicyRow, 'workspace_id' | 'platform'>
      agents:            Table<AgentRow, 'workspace_id' | 'character_id' | 'role' | 'name'>
      agent_tasks:       Table<AgentTaskRow, 'workspace_id' | 'character_id' | 'agent_id' | 'type' | 'title'>
      agent_runs:        Table<AgentRunRow, 'workspace_id' | 'agent_task_id' | 'agent_id' | 'character_id'>
      agent_run_events:  Table<AgentRunEventRow, 'workspace_id' | 'agent_run_id' | 'seq' | 'type'>
    }
    Views: { [_ in never]: never }
    Functions: {
      current_user_is_platform_admin: { Args: Record<string, never>; Returns: boolean }
      claim_agent_tasks: { Args: { p_limit?: number }; Returns: AgentTaskRow[] }
      sync_platform_admin: { Args: { p_user_id: string; p_is_admin: boolean }; Returns: undefined }
    }
    Enums: { [_ in never]: never }
    CompositeTypes: { [_ in never]: never }
  }
}

export type Tables<T extends keyof Database['public']['Tables']> = Database['public']['Tables'][T]['Row']
