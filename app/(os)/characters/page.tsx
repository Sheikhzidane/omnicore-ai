import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { PageHeader, StatusPill } from '@/components/shell/page-header'
import { DataTable } from '@/components/ui/table'
import { NoCharacters } from '@/components/shell/character-filter'

export const dynamic = 'force-dynamic'

export default async function CharacterLibrary() {
  const supabase = await createClient()
  const [{ data: chars }, { data: accounts }, { data: agents }] = await Promise.all([
    supabase.from('characters').select('id, name, slug, status, approval_mode, ai_disclosure_mode, age_restricted, created_at').order('created_at'),
    supabase.from('social_accounts').select('character_id, platform, status'),
    supabase.from('agents').select('character_id, status'),
  ])
  const rows = (chars ?? []).map(c => ({
    ...c,
    connected: (accounts ?? []).filter(a => a.character_id === c.id && a.status === 'connected').map(a => a.platform),
    activeAgents: (agents ?? []).filter(a => a.character_id === c.id && a.status === 'active').length,
  }))
  return (
    <>
      <PageHeader title="Character Library" description="Fictional AI characters in this workspace.">
        <Link href="/characters/new" className="rounded-md bg-cyan-600 px-3 py-2 text-sm font-medium text-white hover:bg-cyan-500">Create character</Link>
      </PageHeader>
      {rows.length === 0 ? <NoCharacters /> : (
        <DataTable rows={rows} empty="" columns={[
          { key: 'name', label: 'Character', render: r => <Link href={`/characters/${r.id}`} className="font-medium text-cyan-300 hover:underline">{r.name}</Link> },
          { key: 'status', label: 'Status', render: r => <StatusPill tone={r.status === 'active' ? 'ok' : r.status === 'paused' ? 'warn' : 'off'}>{r.status}</StatusPill> },
          { key: 'approval', label: 'Publishing', render: r => r.approval_mode === 'human_required' ? 'Human approval' : 'Auto (low risk)' },
          { key: 'accounts', label: 'Connected', render: r => r.connected.length ? r.connected.join(', ') : <span className="text-slate-500">none</span> },
          { key: 'agents', label: 'Active agents', render: r => `${r.activeAgents} / 15` },
          { key: 'aud', label: 'Audience', render: r => r.age_restricted ? '18+' : 'General' },
        ]} />
      )}
    </>
  )
}
