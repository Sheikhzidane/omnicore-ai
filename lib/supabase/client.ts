import { createBrowserClient } from '@supabase/ssr'
import type { Database } from '@/types/database'

// createBrowserClient is internally memoized — calling this multiple times
// in different components returns the same instance and never opens duplicate
// WebSocket connections.
export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}
