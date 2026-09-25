import { createClient } from '@/lib/supabase/server'
import { requireWorkspace } from '@/lib/auth/session'
import { hasRole } from '@/lib/auth/roles'
import { listCharacters } from '@/lib/data/characters'
import { PageHeader, Panel, StatusPill } from '@/components/shell/page-header'
import { ActionForm, Checkbox, Field, Input, SubmitButton } from '@/components/ui/form'
import { savePublishingPolicy } from '../actions'

export const dynamic = 'force-dynamic'
const PLATFORMS = ['instagram', 'tiktok', 'youtube', 'x'] as const

export default async function PublishingPolicies() {
  const { role } = await requireWorkspace()
  const supabase = await createClient()
  const [{ data: policies }, chars] = await Promise.all([supabase.from('publishing_policies').select('*'), listCharacters()])
  const admin = hasRole(role, 'admin')
  const scopes = [{ id: null as string | null, name: 'Workspace default' }, ...chars.map(c => ({ id: c.id as string | null, name: c.name }))]
  return (
    <>
      <PageHeader title="Publishing Policies" description="Per platform, with optional per-character overrides. Without a policy, publishing to that platform is disabled. Sponsored-content disclosure can never be turned off." />
      {scopes.map(s => (
        <section key={s.id ?? 'default'} className="mb-6">
          <h2 className="mb-2 text-sm font-medium text-slate-300">{s.name}</h2>
          <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-4">
            {PLATFORMS.map(p => {
              const pol = policies?.find(x => x.platform === p && x.character_id === s.id)
              return (
                <Panel key={p} title={p}>
                  {!pol && <p className="mb-2"><StatusPill tone="off">{s.id ? 'inherits workspace default' : 'no policy — disabled'}</StatusPill></p>}
                  {admin ? (
                    <ActionForm action={savePublishingPolicy}>
                      <input type="hidden" name="platform" value={p} />
                      {s.id && <input type="hidden" name="characterId" value={s.id} />}
                      <Checkbox name="publishingEnabled" label="Publishing enabled" defaultChecked={pol?.publishing_enabled ?? false} />
                      <Checkbox name="requiresHumanApproval" label="Requires human approval" defaultChecked={pol?.requires_human_approval ?? true} />
                      <Checkbox name="aiLabelRequired" label="AI label on every post" defaultChecked={pol?.ai_label_required ?? true} />
                      <Checkbox name="autoPublishAllowed" label="Allow auto-publish (low risk only)" defaultChecked={pol?.auto_publish_allowed ?? false} />
                      <div className="grid grid-cols-2 gap-2">
                        <Field label="Max posts / day"><Input name="maxPostsPerDay" type="number" min={0} max={25} defaultValue={pol?.max_posts_per_day ?? 3} /></Field>
                        <Field label="Min minutes apart"><Input name="minMinutesBetweenPosts" type="number" min={15} defaultValue={pol?.min_minutes_between_posts ?? 60} /></Field>
                      </div>
                      <SubmitButton tone="ghost">Save</SubmitButton>
                    </ActionForm>
                  ) : pol ? <p className="text-xs text-slate-400">{pol.publishing_enabled ? 'enabled' : 'disabled'} · {pol.requires_human_approval ? 'human approval' : 'no approval'} · {pol.max_posts_per_day}/day</p> : null}
                </Panel>
              )
            })}
          </div>
        </section>
      ))}
    </>
  )
}
