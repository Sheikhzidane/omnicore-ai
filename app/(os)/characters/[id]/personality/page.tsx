import { createClient } from '@/lib/supabase/server'
import { Panel } from '@/components/shell/page-header'
import { ActionForm, Field, Input, SubmitButton, Textarea } from '@/components/ui/form'
import { updatePersonality } from '../../actions'

type P = { traits?: string[]; values?: string[]; quirks?: string[]; humor?: string }
type B = { avoidTopics?: string[]; sensitiveTopicsNeedReview?: string[]; neverSay?: string[] }
type PS = { platforms?: { platform: string }[] }
type M = { channels?: string[]; notes?: string; noGoCategories?: string[] }
const j = (a?: string[]) => (a ?? []).join(', ')

export default async function PersonalityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: p } = await supabase.from('character_profiles').select('*').eq('character_id', id).maybeSingle()
  const per = (p?.personality ?? {}) as P, bnd = (p?.content_boundaries ?? {}) as B, ps = (p?.platform_strategy ?? {}) as PS, mon = (p?.monetisation_strategy ?? {}) as M
  return (
    <Panel>
      <ActionForm action={updatePersonality}>
        <input type="hidden" name="id" value={id} />
        <div className="grid gap-3 lg:grid-cols-2">
          <Field label="Traits" hint="Comma separated"><Input name="traits" defaultValue={j(per.traits)} /></Field>
          <Field label="Values"><Input name="values" defaultValue={j(per.values)} /></Field>
          <Field label="Quirks"><Input name="quirks" defaultValue={j(per.quirks)} /></Field>
          <Field label="Humour"><Input name="humor" defaultValue={per.humor ?? ''} maxLength={200} /></Field>
        </div>
        <Field label="Tone of voice"><Textarea name="toneOfVoice" rows={2} defaultValue={p?.tone_of_voice ?? ''} maxLength={1000} /></Field>
        <Field label="Backstory"><Textarea name="backstory" rows={6} defaultValue={p?.backstory ?? ''} maxLength={5000} /></Field>
        <h3 className="pt-2 text-xs font-medium uppercase tracking-wider text-slate-400">Content boundaries</h3>
        <div className="grid gap-3 lg:grid-cols-3">
          <Field label="Avoid topics"><Textarea name="avoidTopics" rows={3} defaultValue={j(bnd.avoidTopics)} /></Field>
          <Field label="Sensitive (needs review)"><Textarea name="sensitiveTopicsNeedReview" rows={3} defaultValue={j(bnd.sensitiveTopicsNeedReview)} /></Field>
          <Field label="Never say"><Textarea name="neverSay" rows={3} defaultValue={j(bnd.neverSay)} /></Field>
        </div>
        <h3 className="pt-2 text-xs font-medium uppercase tracking-wider text-slate-400">Strategy</h3>
        <div className="grid gap-3 lg:grid-cols-2">
          <Field label="Platforms" hint="instagram, tiktok, youtube, x"><Input name="platforms" defaultValue={(ps.platforms ?? []).map(x => x.platform).join(', ')} /></Field>
          <Field label="Monetisation channels" hint="affiliate, sponsorship, product, subscription, tips, licensing"><Input name="channels" defaultValue={j(mon.channels)} /></Field>
          <Field label="No-go brand categories"><Input name="noGoCategories" defaultValue={j(mon.noGoCategories)} /></Field>
          <Field label="Monetisation notes"><Input name="monetisationNotes" defaultValue={mon.notes ?? ''} maxLength={2000} /></Field>
        </div>
        <SubmitButton>Save personality</SubmitButton>
      </ActionForm>
    </Panel>
  )
}
