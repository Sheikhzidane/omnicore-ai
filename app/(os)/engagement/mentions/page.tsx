import { requireWorkspace } from '@/lib/auth/session'
import { hasRole } from '@/lib/auth/roles'
import { selectedCharacter } from '@/lib/data/characters'
import { engagementFor } from '@/lib/data/engagement'
import { PageHeader } from '@/components/shell/page-header'
import { CharacterFilter, NoCharacters } from '@/components/shell/character-filter'
import { ActionForm, SubmitButton } from '@/components/ui/form'
import { InboxList } from '@/components/engagement/inbox-list'
import { suggestReplies } from '../actions'

export const dynamic = 'force-dynamic'

export default async function MentionsPage({ searchParams }: { searchParams: Promise<{ character?: string }> }) {
  const { role } = await requireWorkspace()
  const { all, current } = await selectedCharacter((await searchParams).character)
  if (!current) return <><PageHeader title="Mentions" /><NoCharacters /></>
  const items = await engagementFor(current.id, { kinds: ['mention'] })
  const canEdit = hasRole(role, 'editor')
  return (
    <>
      <PageHeader title="Mentions" description="Posts that mention the character.">
        {canEdit && <ActionForm action={suggestReplies}><input type="hidden" name="characterId" value={current.id} /><SubmitButton tone="ghost">Suggest replies with the Community agent</SubmitButton></ActionForm>}
      </PageHeader>
      <CharacterFilter path="/engagement/mentions" characters={all} current={current.id} />
      <InboxList items={items} canEdit={canEdit} />
    </>
  )
}
