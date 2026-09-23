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
    }
    Views: { [_ in never]: never }
    Functions: { [_ in never]: never }
    Enums: { [_ in never]: never }
    CompositeTypes: { [_ in never]: never }
  }
}

export type Tables<T extends keyof Database['public']['Tables']> = Database['public']['Tables'][T]['Row']
