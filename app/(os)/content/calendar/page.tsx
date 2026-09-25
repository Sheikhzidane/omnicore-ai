import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { selectedCharacter } from '@/lib/data/characters'
import { PageHeader, Panel } from '@/components/shell/page-header'
import { CharacterFilter, NoCharacters } from '@/components/shell/character-filter'
import { ActionForm, Checkbox, Field, Input, Select, SubmitButton } from '@/components/ui/form'
import { addCalendarSlot, planCalendar } from '../actions'

export const dynamic = 'force-dynamic'

function monthDays(ym: string) {
  const [y, m] = ym.split('-').map(Number)
  const first = new Date(Date.UTC(y, m - 1, 1))
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const lead = (first.getUTCDay() + 6) % 7 // Monday-first
  return { lead, days: Array.from({ length: days }, (_, i) => `${ym}-${String(i + 1).padStart(2, '0')}`) }
}
const shift = (ym: string, d: number) => { const [y, m] = ym.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1 + d, 1)); return t.toISOString().slice(0, 7) }

export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ character?: string; month?: string }> }) {
  const sp = await searchParams
  const { all, current } = await selectedCharacter(sp.character)
  if (!current) return <><PageHeader title="Calendar" /><NoCharacters /></>
  const month = /^\d{4}-\d{2}$/.test(sp.month ?? '') ? sp.month! : new Date().toISOString().slice(0, 7)
  const { lead, days } = monthDays(month)
  const supabase = await createClient()
  const [{ data: slots }, { data: scheduled }] = await Promise.all([
    supabase.from('content_calendar').select('*').eq('character_id', current.id).gte('slot_date', days[0]).lte('slot_date', days[days.length - 1]),
    supabase.from('content_items').select('id, title, platform, status, scheduled_for, published_at').eq('character_id', current.id)
      .or(`and(scheduled_for.gte.${days[0]},scheduled_for.lte.${days[days.length - 1]}T23:59:59Z),and(published_at.gte.${days[0]},published_at.lte.${days[days.length - 1]}T23:59:59Z)`),
  ])
  const q = `character=${current.id}`
  return (
    <>
      <PageHeader title="Calendar" description="Planned slots and scheduled/published posts (dates in UTC).">
        <div className="flex items-center gap-2 text-sm">
          <Link href={`/content/calendar?${q}&month=${shift(month, -1)}`} className="rounded border border-slate-700 px-2 py-1">←</Link>
          <span className="text-slate-200">{month}</span>
          <Link href={`/content/calendar?${q}&month=${shift(month, 1)}`} className="rounded border border-slate-700 px-2 py-1">→</Link>
        </div>
      </PageHeader>
      <CharacterFilter path="/content/calendar" characters={all} current={current.id} />
      <div className="overflow-x-auto">
        <div className="grid min-w-[700px] grid-cols-7 gap-1 text-xs">
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => <div key={d} className="px-2 py-1 text-slate-500">{d}</div>)}
          {Array.from({ length: lead }).map((_, i) => <div key={`l${i}`} />)}
          {days.map(d => {
            const s = (slots ?? []).filter(x => x.slot_date === d)
            const items = (scheduled ?? []).filter(x => (x.published_at ?? x.scheduled_for ?? '').startsWith(d))
            return (
              <div key={d} className="min-h-24 rounded border border-slate-800 bg-slate-900/40 p-1.5">
                <p className="mb-1 text-slate-500">{Number(d.slice(8))}</p>
                {items.map(i => <Link key={i.id} href={`/content/items/${i.id}`} className={`mb-1 block truncate rounded px-1 py-0.5 ${i.status === 'published' ? 'bg-emerald-950 text-emerald-200' : 'bg-cyan-950 text-cyan-200'}`}>{i.platform}: {i.title}</Link>)}
                {s.map(x => <p key={x.id} className="mb-1 truncate rounded border border-dashed border-slate-700 px-1 py-0.5 text-slate-400" title={x.note ?? ''}>{x.platform}{x.slot_time ? ` ${x.slot_time.slice(0, 5)}` : ''} · {x.status}</p>)}
              </div>
            )
          })}
        </div>
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Panel title="Add slot">
          <ActionForm action={addCalendarSlot}>
            <input type="hidden" name="characterId" value={current.id} />
            <div className="grid gap-2 sm:grid-cols-3">
              <Field label="Platform"><Select name="platform" options={['instagram', 'tiktok', 'youtube', 'x'].map(p => ({ value: p, label: p }))} /></Field>
              <Field label="Date"><Input type="date" name="date" required /></Field>
              <Field label="Time"><Input type="time" name="time" /></Field>
            </div>
            <Field label="Timezone"><Input name="timezone" defaultValue="UTC" /></Field>
            <Field label="Note"><Input name="note" maxLength={500} /></Field>
            <SubmitButton>Add slot</SubmitButton>
          </ActionForm>
        </Panel>
        <Panel title="Plan with the Content Planner agent">
          <ActionForm action={planCalendar}>
            <input type="hidden" name="characterId" value={current.id} />
            <div className="grid gap-2 sm:grid-cols-2">
              <Field label="Start date"><Input type="date" name="startDate" required /></Field>
              <Field label="Days"><Input type="number" name="days" min={1} max={31} defaultValue={7} /></Field>
            </div>
            <Field label="Timezone"><Input name="timezone" defaultValue="UTC" /></Field>
            <div className="flex flex-wrap gap-4">{['instagram', 'tiktok', 'youtube', 'x'].map(p => <Checkbox key={p} name="platforms" value={p} label={p} />)}</div>
            <SubmitButton>Plan</SubmitButton>
          </ActionForm>
        </Panel>
      </div>
    </>
  )
}
