import { createClient } from '@/lib/supabase/server'
import { getCharacter } from '@/lib/data/characters'
import { Panel } from '@/components/shell/page-header'
import { ActionForm, Checkbox, Field, Input, Select, SubmitButton, Textarea } from '@/components/ui/form'
import { updateBasics, updateSafety } from '../actions'

export default async function ProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const c = await getCharacter(id)
  const supabase = await createClient()
  const { data: p } = await supabase.from('character_profiles').select('*').eq('character_id', id).maybeSingle()
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Panel title="Profile">
        <ActionForm action={updateBasics}>
          <input type="hidden" name="id" value={id} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name"><Input name="name" defaultValue={c.name} required maxLength={120} /></Field>
            <Field label="Display name"><Input name="displayName" defaultValue={p?.display_name ?? c.name} required maxLength={80} /></Field>
            <Field label="Niche"><Input name="niche" defaultValue={p?.niche ?? ''} maxLength={120} /></Field>
            <Field label="Language"><Input name="language" defaultValue={p?.language ?? 'en'} /></Field>
          </div>
          <Field label="Description"><Textarea name="description" defaultValue={p?.description ?? ''} maxLength={2000} /></Field>
          <Field label="Target audience"><Textarea name="targetAudience" rows={2} defaultValue={p?.target_audience ?? ''} maxLength={1000} /></Field>
          <Field label="Status" hint="Only active characters can publish.">
            <Select name="status" defaultValue={c.status} options={['draft', 'active', 'paused', 'archived'].map(s => ({ value: s, label: s }))} />
          </Field>
          <SubmitButton>Save profile</SubmitButton>
        </ActionForm>
      </Panel>
      <Panel title="Safety & disclosure (admins)">
        <ActionForm action={updateSafety}>
          <input type="hidden" name="id" value={id} />
          <Field label="AI disclosure">
            <Select name="aiDisclosureMode" defaultValue={c.ai_disclosure_mode} options={[{ value: 'always', label: 'Always' }, { value: 'bio_and_posts', label: 'Bio and posts' }, { value: 'bio_only', label: 'Bio only' }]} />
          </Field>
          <Field label="Disclosure text"><Input name="disclosureText" defaultValue={c.disclosure_text} minLength={3} maxLength={200} required /></Field>
          <Field label="Publishing approval">
            <Select name="approvalMode" defaultValue={c.approval_mode} options={[{ value: 'human_required', label: 'Human approval for every post' }, { value: 'auto_low_risk', label: 'Auto-publish low risk where policy allows' }]} />
          </Field>
          <Field label="Minimum audience age"><Input type="number" name="minAudienceAge" min={13} max={21} defaultValue={c.min_audience_age} /></Field>
          <Checkbox name="ageRestricted" label="Adults only (18+)" defaultChecked={c.age_restricted} />
          <Checkbox name="depictsRealPerson" label="Depicts or is based on a real person" defaultChecked={c.depicts_real_person} />
          <Field label="Consent evidence (storage path)" hint="Required for a real-person likeness: upload the signed consent as a 'consent_evidence' asset, then paste its path here.">
            <Input name="consentEvidencePath" defaultValue={c.consent_evidence_path ?? ''} maxLength={500} />
          </Field>
          <SubmitButton>Save safety settings</SubmitButton>
        </ActionForm>
      </Panel>
    </div>
  )
}
