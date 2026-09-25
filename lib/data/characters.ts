import 'server-only'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

/** Reads go through the RLS-scoped server client: members see only their workspace. */
export async function listCharacters() {
  const supabase = await createClient()
  const { data } = await supabase.from('characters').select('id, name, slug, status').order('created_at')
  return data ?? []
}

export async function getCharacter(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound()
  const supabase = await createClient()
  const { data } = await supabase.from('characters').select('*').eq('id', id).maybeSingle()
  if (!data) notFound()
  return data
}

/** Picks the character from ?character=, falling back to the first one. */
export async function selectedCharacter(param: string | undefined) {
  const all = await listCharacters()
  return { all, current: all.find(c => c.id === param) ?? all[0] ?? null }
}
