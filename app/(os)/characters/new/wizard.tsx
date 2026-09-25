'use client'

import { useActionState, useState } from 'react'
import { createCharacter } from '../actions'
import { Checkbox, Field, Input, Select, SubmitButton, Textarea } from '@/components/ui/form'
import { cn } from '@/lib/utils'

const STEPS = ['Basics', 'Personality & voice', 'Visual identity', 'Brand rules & boundaries', 'Platforms & monetisation', 'Safety & review'] as const
const PLATFORMS = ['instagram', 'tiktok', 'youtube', 'x'] as const
const CHANNELS = ['affiliate', 'sponsorship', 'product', 'subscription', 'tips', 'licensing'] as const
const RULE_TYPES = ['do', 'dont', 'voice', 'topic_allowed', 'topic_blocked', 'hashtag', 'cta', 'brand_safety'] as const
const list = (s: string) => s.split(/[\n,]/).map(x => x.trim()).filter(Boolean)

export function CharacterWizard() {
  const [step, setStep] = useState(0)
  const [state, action] = useActionState(createCharacter, null)
  const [f, setF] = useState({
    name: '', displayName: '', description: '', niche: '', targetAudience: '', language: 'en',
    traits: '', values: '', quirks: '', humor: '', toneOfVoice: '', backstory: '',
    appearanceDescription: '', styleKeywords: '', colorPalette: '', cameraStyle: '', promptPrefix: '', negativePrompt: '', doNotDepict: '',
    rules: [] as { ruleType: (typeof RULE_TYPES)[number]; rule: string }[], ruleType: 'do' as (typeof RULE_TYPES)[number], rule: '',
    avoidTopics: '', sensitiveTopicsNeedReview: '', neverSay: '',
    platforms: [] as string[], channels: [] as string[], monetisationNotes: '', noGoCategories: '',
    aiDisclosureMode: 'always', disclosureText: 'AI-generated virtual character', approvalMode: 'human_required', minAudienceAge: 13, ageRestricted: false,
  })
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF(p => ({ ...p, [k]: v }))
  const toggle = (k: 'platforms' | 'channels', v: string) => set(k, f[k].includes(v) ? f[k].filter(x => x !== v) : [...f[k], v])

  const payload = JSON.stringify({
    basics: { name: f.name, displayName: f.displayName || f.name, description: f.description || undefined, niche: f.niche || undefined, targetAudience: f.targetAudience || undefined, language: f.language },
    voice: { personality: { traits: list(f.traits), values: list(f.values), quirks: list(f.quirks), humor: f.humor || undefined }, toneOfVoice: f.toneOfVoice || undefined, backstory: f.backstory || undefined },
    visual: { appearanceDescription: f.appearanceDescription || undefined, styleKeywords: list(f.styleKeywords), colorPalette: list(f.colorPalette), cameraStyle: f.cameraStyle || undefined, promptPrefix: f.promptPrefix || undefined, negativePrompt: f.negativePrompt || undefined, doNotDepict: list(f.doNotDepict) },
    brandRules: f.rules.map(r => ({ ...r, priority: 3 })),
    boundaries: { avoidTopics: list(f.avoidTopics), sensitiveTopicsNeedReview: list(f.sensitiveTopicsNeedReview), neverSay: list(f.neverSay) },
    platformStrategy: { platforms: f.platforms.map(p => ({ platform: p, formats: [] })) },
    monetisationStrategy: { channels: f.channels, notes: f.monetisationNotes || undefined, noGoCategories: list(f.noGoCategories) },
    safety: { aiDisclosureMode: f.aiDisclosureMode, disclosureText: f.disclosureText, approvalMode: f.approvalMode, minAudienceAge: Number(f.minAudienceAge), ageRestricted: f.ageRestricted, depictsRealPerson: false },
  })
  const canNext = step !== 0 || f.name.trim().length > 0

  return (
    <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
      <ol className="flex gap-2 overflow-x-auto lg:flex-col" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s}>
            <button type="button" onClick={() => (i <= step || canNext) && setStep(i)} aria-current={i === step ? 'step' : undefined}
              className={cn('whitespace-nowrap rounded-md px-3 py-2 text-left text-xs', i === step ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-slate-200')}>
              {i + 1}. {s}
            </button>
          </li>
        ))}
      </ol>

      <form action={action} className="space-y-4 rounded-lg border border-slate-800 bg-slate-900/40 p-4">
        <input type="hidden" name="payload" value={payload} />
        {step === 0 && <>
          <Field label="Name (internal)"><Input required value={f.name} onChange={e => set('name', e.target.value)} maxLength={120} /></Field>
          <Field label="Display name" hint="Shown on profiles. Must be a fictional name — never a real person's."><Input value={f.displayName} onChange={e => set('displayName', e.target.value)} maxLength={80} /></Field>
          <Field label="Description"><Textarea value={f.description} onChange={e => set('description', e.target.value)} maxLength={2000} /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Niche"><Input value={f.niche} onChange={e => set('niche', e.target.value)} maxLength={120} /></Field>
            <Field label="Language" hint="e.g. en, en-GB, bn"><Input value={f.language} onChange={e => set('language', e.target.value)} /></Field>
          </div>
          <Field label="Target audience"><Textarea rows={2} value={f.targetAudience} onChange={e => set('targetAudience', e.target.value)} maxLength={1000} /></Field>
        </>}
        {step === 1 && <>
          <Field label="Personality traits" hint="Comma or newline separated"><Textarea rows={2} value={f.traits} onChange={e => set('traits', e.target.value)} /></Field>
          <Field label="Values"><Textarea rows={2} value={f.values} onChange={e => set('values', e.target.value)} /></Field>
          <Field label="Quirks"><Textarea rows={2} value={f.quirks} onChange={e => set('quirks', e.target.value)} /></Field>
          <Field label="Humour"><Input value={f.humor} onChange={e => set('humor', e.target.value)} maxLength={200} /></Field>
          <Field label="Tone of voice"><Textarea rows={2} value={f.toneOfVoice} onChange={e => set('toneOfVoice', e.target.value)} maxLength={1000} /></Field>
          <Field label="Backstory" hint="Fictional. Agents treat this as canon."><Textarea rows={5} value={f.backstory} onChange={e => set('backstory', e.target.value)} maxLength={5000} /></Field>
        </>}
        {step === 2 && <>
          <Field label="Appearance"><Textarea value={f.appearanceDescription} onChange={e => set('appearanceDescription', e.target.value)} maxLength={4000} /></Field>
          <Field label="Style keywords"><Input value={f.styleKeywords} onChange={e => set('styleKeywords', e.target.value)} /></Field>
          <Field label="Colour palette" hint="Hex colours, e.g. #0EA5E9, #F97316"><Input value={f.colorPalette} onChange={e => set('colorPalette', e.target.value)} /></Field>
          <Field label="Camera / photography style"><Input value={f.cameraStyle} onChange={e => set('cameraStyle', e.target.value)} maxLength={500} /></Field>
          <Field label="Image prompt prefix"><Textarea rows={2} value={f.promptPrefix} onChange={e => set('promptPrefix', e.target.value)} maxLength={2000} /></Field>
          <Field label="Negative prompt"><Textarea rows={2} value={f.negativePrompt} onChange={e => set('negativePrompt', e.target.value)} maxLength={2000} /></Field>
          <Field label="Never depict"><Textarea rows={2} value={f.doNotDepict} onChange={e => set('doNotDepict', e.target.value)} /></Field>
        </>}
        {step === 3 && <>
          <div className="grid gap-2 sm:grid-cols-[160px_1fr_auto] sm:items-end">
            <Field label="Rule type"><Select value={f.ruleType} onChange={e => set('ruleType', e.target.value as (typeof RULE_TYPES)[number])} options={RULE_TYPES.map(r => ({ value: r, label: r }))} /></Field>
            <Field label="Brand rule"><Input value={f.rule} onChange={e => set('rule', e.target.value)} maxLength={500} /></Field>
            <button type="button" className="rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
              onClick={() => { if (f.rule.trim()) { set('rules', [...f.rules, { ruleType: f.ruleType, rule: f.rule.trim() }]); set('rule', '') } }}>Add</button>
          </div>
          {f.rules.length > 0 && (
            <ul className="space-y-1 text-sm">
              {f.rules.map((r, i) => (
                <li key={i} className="flex items-center justify-between gap-2 rounded border border-slate-800 px-2 py-1">
                  <span><span className="text-xs text-slate-500">{r.ruleType}</span> {r.rule}</span>
                  <button type="button" onClick={() => set('rules', f.rules.filter((_, j) => j !== i))} className="text-xs text-slate-400 hover:text-red-300">Remove</button>
                </li>
              ))}
            </ul>
          )}
          <Field label="Topics to avoid"><Textarea rows={2} value={f.avoidTopics} onChange={e => set('avoidTopics', e.target.value)} /></Field>
          <Field label="Sensitive topics that need review"><Textarea rows={2} value={f.sensitiveTopicsNeedReview} onChange={e => set('sensitiveTopicsNeedReview', e.target.value)} /></Field>
          <Field label="Never say"><Textarea rows={2} value={f.neverSay} onChange={e => set('neverSay', e.target.value)} /></Field>
        </>}
        {step === 4 && <>
          <fieldset className="space-y-2"><legend className="text-xs font-medium text-slate-300">Platforms</legend>
            <div className="flex flex-wrap gap-4">{PLATFORMS.map(p => <Checkbox key={p} label={p} checked={f.platforms.includes(p)} onChange={() => toggle('platforms', p)} />)}</div>
          </fieldset>
          <fieldset className="space-y-2"><legend className="text-xs font-medium text-slate-300">Monetisation channels</legend>
            <div className="flex flex-wrap gap-4">{CHANNELS.map(c => <Checkbox key={c} label={c} checked={f.channels.includes(c)} onChange={() => toggle('channels', c)} />)}</div>
          </fieldset>
          <Field label="Monetisation notes"><Textarea rows={3} value={f.monetisationNotes} onChange={e => set('monetisationNotes', e.target.value)} maxLength={2000} /></Field>
          <Field label="No-go brand categories"><Textarea rows={2} value={f.noGoCategories} onChange={e => set('noGoCategories', e.target.value)} /></Field>
        </>}
        {step === 5 && <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="AI disclosure" hint="Posts are always labelled unless the platform policy says otherwise.">
              <Select value={f.aiDisclosureMode} onChange={e => set('aiDisclosureMode', e.target.value)} options={[{ value: 'always', label: 'Always (bio and every post)' }, { value: 'bio_and_posts', label: 'Bio and posts' }, { value: 'bio_only', label: 'Bio only (posts still labelled where required)' }]} />
            </Field>
            <Field label="Disclosure text"><Input value={f.disclosureText} onChange={e => set('disclosureText', e.target.value)} minLength={3} maxLength={200} /></Field>
            <Field label="Publishing approval">
              <Select value={f.approvalMode} onChange={e => set('approvalMode', e.target.value)} options={[{ value: 'human_required', label: 'Human approval for every post (recommended)' }, { value: 'auto_low_risk', label: 'Allow auto-publish of low-risk posts where policy permits' }]} />
            </Field>
            <Field label="Minimum audience age"><Input type="number" min={13} max={21} value={f.minAudienceAge} onChange={e => set('minAudienceAge', Number(e.target.value))} /></Field>
          </div>
          <Checkbox label="Adults only (18+)" checked={f.ageRestricted} onChange={e => { set('ageRestricted', e.target.checked); if (e.target.checked && f.minAudienceAge < 18) set('minAudienceAge', 18) }} />
          <p className="rounded border border-slate-800 bg-slate-950 p-3 text-xs text-slate-400">
            This character is fictional and will be presented as AI. Characters based on a real person need that person&apos;s documented consent, which you can add on the Profile page after creation.
            The 15 agents are created <strong>disabled</strong>; nothing runs until you enable them and set <code>AGENTS_ENABLED=true</code>.
          </p>
        </>}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 pt-4">
          <button type="button" disabled={step === 0} onClick={() => setStep(step - 1)} className="rounded-md px-3 py-2 text-sm text-slate-300 disabled:opacity-30">Back</button>
          {step < STEPS.length - 1
            ? <button type="button" disabled={!canNext} onClick={() => setStep(step + 1)} className="rounded-md bg-slate-700 px-3 py-2 text-sm text-white disabled:opacity-40">Next</button>
            : <SubmitButton>Create character</SubmitButton>}
        </div>
        {state && !state.ok && <p role="alert" className="text-xs text-red-300">{state.message}</p>}
      </form>
    </div>
  )
}
