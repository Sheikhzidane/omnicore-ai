import { createClient } from '@/lib/supabase/server'
import { getCharacter } from '@/lib/data/characters'
import { DEFAULT_POLICY, HARD_BLOCKED_CATEGORIES, parsePolicy } from '@/lib/safety/policy'
import { Panel } from '@/components/shell/page-header'
import { ActionForm, Field, Select, SubmitButton, Textarea } from '@/components/ui/form'
import { saveContentPolicy } from '../../actions'

export default async function ContentPolicyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const c = await getCharacter(id)
  const supabase = await createClient()
  const { data: pol } = c.content_policy_id ? await supabase.from('content_policies').select('rules, version').eq('id', c.content_policy_id).maybeSingle() : { data: null }
  const rules = pol ? parsePolicy(pol.rules) : DEFAULT_POLICY
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
      <Panel title={pol ? `Policy v${pol.version}` : 'Using the default policy'}>
        <ActionForm action={saveContentPolicy}>
          <input type="hidden" name="id" value={id} />
          <Field label="Blocked topics" hint="Content mentioning these is blocked."><Textarea name="blockedTopics" rows={3} defaultValue={rules.blockedTopics.join(', ')} /></Field>
          <Field label="Review terms" hint="Content mentioning these needs a human to clear it."><Textarea name="reviewTerms" rows={3} defaultValue={rules.reviewTerms.join(', ')} /></Field>
          <Field label="Require disclaimers for" hint="health, finance, legal"><Textarea name="requireDisclaimerFor" rows={1} defaultValue={rules.requireDisclaimerFor.join(', ')} /></Field>
          <Field label="Maximum content rating"><Select name="maxRating" defaultValue={rules.maxRating} options={[{ value: 'general', label: 'General' }, { value: 'teen', label: 'Teen' }, { value: 'mature', label: 'Mature (18+ characters only)' }]} /></Field>
          <SubmitButton>Save policy</SubmitButton>
        </ActionForm>
      </Panel>
      <Panel title="Always blocked (cannot be changed)">
        <ul className="space-y-1 text-xs text-slate-400">{HARD_BLOCKED_CATEGORIES.map(h => <li key={h}>• {h.replaceAll('_', ' ')}</li>)}</ul>
      </Panel>
    </div>
  )
}
