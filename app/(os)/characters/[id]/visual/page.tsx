import { createClient } from '@/lib/supabase/server'
import { Panel } from '@/components/shell/page-header'
import { ActionForm, Field, Input, SubmitButton, Textarea } from '@/components/ui/form'
import { updateVisual } from '../../actions'

export default async function VisualPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: v } = await supabase.from('character_visual_rules').select('*').eq('character_id', id).maybeSingle()
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_280px]">
      <Panel>
        <ActionForm action={updateVisual}>
          <input type="hidden" name="id" value={id} />
          <Field label="Appearance"><Textarea name="appearanceDescription" rows={4} defaultValue={v?.appearance_description ?? ''} maxLength={4000} /></Field>
          <div className="grid gap-3 lg:grid-cols-2">
            <Field label="Style keywords"><Input name="styleKeywords" defaultValue={(v?.style_keywords ?? []).join(', ')} /></Field>
            <Field label="Colour palette" hint="#RRGGBB, comma separated"><Input name="colorPalette" defaultValue={(v?.color_palette ?? []).join(', ')} /></Field>
            <Field label="Camera style"><Input name="cameraStyle" defaultValue={v?.camera_style ?? ''} maxLength={500} /></Field>
            <Field label="Never depict"><Input name="doNotDepict" defaultValue={(v?.do_not_depict ?? []).join(', ')} /></Field>
          </div>
          <Field label="Image prompt prefix"><Textarea name="promptPrefix" rows={2} defaultValue={v?.prompt_prefix ?? ''} maxLength={2000} /></Field>
          <Field label="Negative prompt"><Textarea name="negativePrompt" rows={2} defaultValue={v?.negative_prompt ?? ''} maxLength={2000} /></Field>
          <SubmitButton>Save visual identity</SubmitButton>
        </ActionForm>
      </Panel>
      <Panel title="Palette">
        {(v?.color_palette ?? []).length ? (
          <ul className="grid grid-cols-4 gap-2">
            {v!.color_palette.map(c => <li key={c} className="text-center text-[10px] text-slate-400"><span className="mb-1 block h-10 rounded border border-slate-700" style={{ background: c }} />{c}</li>)}
          </ul>
        ) : <p className="text-sm text-slate-500">No colours set.</p>}
      </Panel>
    </div>
  )
}
