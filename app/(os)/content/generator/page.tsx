import { createClient } from '@/lib/supabase/server'
import { selectedCharacter } from '@/lib/data/characters'
import { aiProviderSummary } from '@/lib/ai/registry'
import { PageHeader, Panel } from '@/components/shell/page-header'
import { CharacterFilter, NoCharacters } from '@/components/shell/character-filter'
import { ActionForm, Checkbox, Field, Input, Select, SubmitButton, Textarea } from '@/components/ui/form'
import { NotConfigured } from '@/components/ui/table'
import { createItem } from '../actions'

export const dynamic = 'force-dynamic'

export default async function GeneratorPage({ searchParams }: { searchParams: Promise<{ character?: string; idea?: string }> }) {
  const sp = await searchParams
  const { all, current } = await selectedCharacter(sp.character)
  if (!current) return <><PageHeader title="Generator" /><NoCharacters /></>
  const supabase = await createClient()
  const [{ data: idea }, { data: deals }] = await Promise.all([
    sp.idea ? supabase.from('content_ideas').select('*').eq('id', sp.idea).eq('character_id', current.id).maybeSingle() : Promise.resolve({ data: null }),
    supabase.from('brand_deals').select('id, title').eq('character_id', current.id).in('status', ['contracted', 'in_production']),
  ])
  const ai = aiProviderSummary()
  return (
    <>
      <PageHeader title="Generator" description="Create a content item and, optionally, have the Copywriter agent draft it." />
      <CharacterFilter path="/content/generator" characters={all} current={current.id} />
      {!ai.text && <div className="mb-4"><NotConfigured what="Text generation" missing={['ANTHROPIC_API_KEY or OPENAI_API_KEY']}>You can still write content yourself.</NotConfigured></div>}
      <Panel>
        <ActionForm action={createItem}>
          <input type="hidden" name="characterId" value={current.id} />
          {idea && <input type="hidden" name="ideaId" value={idea.id} />}
          <Field label="Title"><Input name="title" required maxLength={300} defaultValue={idea?.title ?? ''} /></Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Platform"><Select name="platform" defaultValue={idea?.platforms[0] ?? 'instagram'} options={['instagram', 'tiktok', 'youtube', 'x'].map(p => ({ value: p, label: p }))} /></Field>
            <Field label="Format"><Select name="format" options={['post', 'carousel', 'reel', 'short', 'story', 'thread', 'video', 'live_script'].map(p => ({ value: p, label: p }))} /></Field>
            <Field label="Rating"><Select name="contentRating" options={[{ value: 'general', label: 'General' }, { value: 'teen', label: 'Teen' }, { value: 'mature', label: 'Mature (18+ only)' }]} /></Field>
          </div>
          {(deals ?? []).length > 0 && (
            <Field label="Sponsored by (brand deal)" hint="Sponsored content gets #ad and always needs human approval.">
              <Select name="brandDealId" options={[{ value: '', label: 'Not sponsored' }, ...(deals ?? []).map(d => ({ value: d.id, label: d.title }))]} />
            </Field>
          )}
          <Field label="Brief for the Copywriter"><Textarea name="brief" rows={3} maxLength={4000} defaultValue={[idea?.summary, idea?.angle].filter(Boolean).join('\n')} /></Field>
          <Field label="Or write the caption yourself"><Textarea name="caption" rows={4} maxLength={10000} /></Field>
          <Checkbox name="draftWithAi" label="Draft the caption with the Copywriter agent now" defaultChecked={Boolean(ai.text)} disabled={!ai.text} />
          <SubmitButton>Create content</SubmitButton>
        </ActionForm>
      </Panel>
    </>
  )
}
