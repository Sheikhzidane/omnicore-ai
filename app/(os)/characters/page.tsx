import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { ModuleIndex, Panel } from '@/components/shell/module-pages'
import { StatusPill } from '@/components/shell/page-header'

export const dynamic = 'force-dynamic'

export default async function CharactersPage() {
  const supabase = await createClient()
  const { data: characters } = await supabase
    .from('characters')
    .select('id, name, slug, status, approval_mode, ai_disclosure_mode, age_restricted')
    .order('created_at', { ascending: true })

  return (
    <ModuleIndex href="/characters">
      <Panel title="Character Library" className="mb-6">
        {characters && characters.length > 0 ? (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-slate-500">
              <tr><th className="py-1">Name</th><th>Status</th><th>Approval</th><th>AI disclosure</th><th>Audience</th></tr>
            </thead>
            <tbody>
              {characters.map(c => (
                <tr key={c.id} className="border-t border-slate-800">
                  <td className="py-2 text-slate-100">{c.name}</td>
                  <td><StatusPill tone={c.status === 'active' ? 'ok' : 'off'}>{c.status}</StatusPill></td>
                  <td className="text-slate-400">{c.approval_mode === 'human_required' ? 'Human required' : 'Auto (low risk)'}</td>
                  <td className="text-slate-400">{c.ai_disclosure_mode}</td>
                  <td className="text-slate-400">{c.age_restricted ? '18+' : 'General'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-slate-500">
            No characters yet. Character creation arrives in Phase 2 — see <Link className="underline" href="/characters/new">Create Character</Link>.
          </p>
        )}
      </Panel>
    </ModuleIndex>
  )
}
