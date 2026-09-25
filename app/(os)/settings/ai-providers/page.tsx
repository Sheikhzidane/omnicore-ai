import { aiProviderSummary } from '@/lib/ai/registry'
import { integrationStates } from '@/lib/config/integrations'
import { PageHeader, Panel, StatusPill } from '@/components/shell/page-header'

export const dynamic = 'force-dynamic'

export default async function AiProvidersPage() {
  const s = aiProviderSummary()
  const ai = integrationStates(process.env).filter(i => i.category === 'ai' || i.category === 'media')
  const rows: [string, string | null, string][] = [
    ['Text (agents, drafting)', s.text, 'AI_TEXT_PROVIDER · ANTHROPIC_API_KEY / OPENAI_API_KEY'],
    ['Image generation', s.image, 'AI_IMAGE_PROVIDER · OPENAI_API_KEY'],
    ['Video generation', s.video, 'AI_VIDEO_PROVIDER=openai · OPENAI_API_KEY'],
    ['Moderation', s.moderation, 'AI_MODERATION_PROVIDER · OPENAI_API_KEY or ANTHROPIC_API_KEY'],
    ['Embeddings', s.embeddings, 'AI_EMBEDDING_PROVIDER · OPENAI_API_KEY'],
  ]
  return (
    <>
      <PageHeader title="AI Providers" description="Chosen from server environment variables. Keys are never shown or sent to the browser." />
      {s.mock && <p role="alert" className="mb-4 rounded border border-amber-900 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">AI_PROVIDER_MODE=mock — outputs are labelled fakes for local development. This mode is refused in production.</p>}
      <Panel title="Capabilities" className="mb-4">
        <ul className="divide-y divide-slate-800 text-sm">
          {rows.map(([label, id, env]) => (
            <li key={label} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div><p className="text-slate-200">{label}</p><p className="text-xs text-slate-500">{env}</p></div>
              <StatusPill tone={id ? 'ok' : 'off'}>{id ?? 'not configured'}</StatusPill>
            </li>
          ))}
        </ul>
      </Panel>
      <Panel title="Credentials present">
        <ul className="space-y-1 text-sm">{ai.map(i => <li key={i.id} className="flex justify-between"><span>{i.name}</span><StatusPill tone={i.status === 'configured' ? 'ok' : 'off'}>{i.status === 'configured' ? 'configured' : `missing ${i.missing.join(', ')}`}</StatusPill></li>)}</ul>
        <p className="mt-2 text-xs text-slate-500">&quot;Configured&quot; means the variables are set, not that a call has succeeded. Agent runs record every provider error in AI Agents → Runs.</p>
      </Panel>
    </>
  )
}
