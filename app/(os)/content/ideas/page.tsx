import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { selectedCharacter } from '@/lib/data/characters'
import { PageHeader, Panel, StatusPill } from '@/components/shell/page-header'
import { CharacterFilter, NoCharacters } from '@/components/shell/character-filter'
import { ActionForm, Checkbox, Field, Input, SubmitButton, Textarea } from '@/components/ui/form'
import { DataTable } from '@/components/ui/table'
import { addIdea, generateIdeas, setIdeaStatus } from '../actions'

export const dynamic = 'force-dynamic'

export default async function IdeasPage({ searchParams }: { searchParams: Promise<{ character?: string }> }) {
  const { all, current } = await selectedCharacter((await searchParams).character)
  if (!current) return <><PageHeader title="Ideas" /><NoCharacters /></>
  const supabase = await createClient()
  const { data } = await supabase.from('content_ideas').select('*').eq('character_id', current.id).neq('status', 'rejected').order('created_at', { ascending: false }).limit(100)
  return (
    <>
      <PageHeader title="Ideas" description="Your ideas and the Content Planner agent's suggestions." />
      <CharacterFilter path="/content/ideas" characters={all} current={current.id} />
      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Panel title="Add an idea">
          <ActionForm action={addIdea}>
            <input type="hidden" name="characterId" value={current.id} />
            <Field label="Title"><Input name="title" required maxLength={300} /></Field>
            <Field label="Summary"><Textarea name="summary" rows={2} maxLength={2000} /></Field>
            <Field label="Angle"><Input name="angle" maxLength={500} /></Field>
            <div className="flex flex-wrap gap-4">{['instagram', 'tiktok', 'youtube', 'x'].map(p => <Checkbox key={p} name="platforms" value={p} label={p} />)}</div>
            <SubmitButton>Save idea</SubmitButton>
          </ActionForm>
        </Panel>
        <Panel title="Ask the Content Planner agent">
          <ActionForm action={generateIdeas}>
            <input type="hidden" name="characterId" value={current.id} />
            <Field label="Theme (optional)"><Input name="theme" maxLength={500} /></Field>
            <Field label="How many"><Input name="count" type="number" min={1} max={10} defaultValue={5} /></Field>
            <SubmitButton>Generate ideas</SubmitButton>
          </ActionForm>
          <p className="mt-2 text-xs text-slate-500">Requires the Content Planner agent to be enabled, a text AI provider, and AGENTS_ENABLED=true.</p>
        </Panel>
      </div>
      <DataTable rows={data ?? []} empty="No ideas yet." columns={[
        { key: 't', label: 'Idea', render: i => <div><p className="font-medium text-slate-100">{i.title}</p>{i.summary && <p className="text-xs text-slate-400">{i.summary}</p>}</div> },
        { key: 'p', label: 'Platforms', render: i => i.platforms.join(', ') || '—' },
        { key: 's', label: 'Source', render: i => <StatusPill tone={i.source === 'agent' ? 'info' : 'off'}>{i.source}</StatusPill> },
        { key: 'sc', label: 'Score', render: i => i.score ?? '—' },
        { key: 'st', label: 'Status', render: i => i.status },
        { key: 'a', label: '', render: i => (
          <div className="flex flex-wrap gap-2">
            {i.status !== 'converted' && <Link href={`/content/generator?character=${current.id}&idea=${i.id}`} className="rounded-md border border-slate-700 px-2 py-1 text-xs text-cyan-300 hover:bg-slate-800">Create content</Link>}
            {i.status === 'new' && <ActionForm action={setIdeaStatus}><input type="hidden" name="ideaId" value={i.id} /><input type="hidden" name="status" value="rejected" /><SubmitButton tone="ghost" className="px-2 py-1 text-xs">Reject</SubmitButton></ActionForm>}
          </div>
        ) },
      ]} />
    </>
  )
}
