import 'server-only'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

/**
 * Server-side admin client using the SUPABASE_SERVICE_ROLE_KEY.
 *
 * Use this for trusted mutations from API routes and server actions —
 * it bypasses row-level security, so **never** expose it to the browser.
 *
 * If a mutation fires Postgres triggers that write to other tables with
 * RLS (e.g. `tasks_search_index`), the anon-key client will 403 on those
 * secondary writes. This admin client avoids that class of failure.
 */
export function createAdminClient() {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required')
  return createClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}
