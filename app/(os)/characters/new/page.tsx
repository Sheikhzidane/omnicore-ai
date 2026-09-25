import { PageHeader } from '@/components/shell/page-header'
import { requireWorkspace } from '@/lib/auth/session'
import { CharacterWizard } from './wizard'

export default async function NewCharacterPage() {
  await requireWorkspace('editor')
  return (
    <>
      <PageHeader title="Create Character" description="Six steps. Everything can be edited later. The character starts as a draft with all agents disabled." />
      <CharacterWizard />
    </>
  )
}
