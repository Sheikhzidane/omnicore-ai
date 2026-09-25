import { requireWorkspace } from '@/lib/auth/session'
import { hasRole } from '@/lib/auth/roles'
import { selectedCharacter } from '@/lib/data/characters'
import { createClient } from '@/lib/supabase/server'
import { getModerationProvider } from '@/lib/ai/registry'
import { PageHeader } from '@/components/shell/page-header'
import { CharacterFilter, NoCharacters } from '@/components/shell/character-filter'
import { ActionForm, SubmitButton } from '@/components/ui/form'
import { NotConfigured } from '@/components/ui/table'
import { InboxList } from '@/components/engagement/inbox-list'
import { moderateItems } from '../actions'

export const dynamic = 'force-dynamic'

export default async function ModerationPage({ searchParams }: { searchParams: Promise<{ character?: string }> }) {
  const { role } = await requireWorkspace()
  const { all, current } = await selectedCharacter((await searchParams).character)
  if (!current) return <><PageHeader title="Moderation" /><NoCharacters /></>
  const supabase = await createClient()
  const { data } = await supabase.from('engagement_items').select('*').eq('character_id', current.id).in('moderation_status', ['flagged', 'blocked']).order('received_at', { ascending: false }).limit(100)
  const provider = getModerationProvider()
  return (
    <>
      <PageHeader title="Moderation" description="Incoming comments checked by the moderation provider. Hiding here hides the item in Omnicore; it does not delete it on the platform.">
        {provider && hasRole(role, 'editor') && <ActionForm action={moderateItems}><input type="hidden" name="characterId" value={current.id} /><SubmitButton tone="ghost">Check unmoderated items</SubmitButton></ActionForm>}
      </PageHeader>
      <CharacterFilter path="/engagement/moderation" characters={all} current={current.id} />
      {!provider && <div className="mb-4"><NotConfigured what="Moderation" missing={['OPENAI_API_KEY or ANTHROPIC_API_KEY']} /></div>}
      <InboxList items={data ?? []} canEdit={hasRole(role, 'editor')} />
    </>
  )
}
