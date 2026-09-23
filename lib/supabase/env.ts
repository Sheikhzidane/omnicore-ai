// Public Supabase connection settings. The anon/publishable key is designed to
// be public — RLS is what protects data. The service-role key is NOT read here
// (see lib/supabase/admin.ts, server-only).
export function supabasePublicEnv(): { url: string; anonKey: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) return null
  return { url, anonKey }
}
