/**
 * Registry of every external integration and the SERVER-SIDE env vars it
 * needs. Status is computed from presence only — values are never read into
 * responses, logged, or sent to the client. "configured" means credentials
 * are present, not that they work; accounts are not "connected" until an
 * OAuth flow succeeds (later phases). Nothing here pretends to be connected.
 *
 * Pure: `env` is injectable for tests. Server code passes process.env.
 */

export type IntegrationCategory = 'core' | 'ai' | 'social' | 'payments' | 'email' | 'media' | 'security'
export type IntegrationStatus = 'configured' | 'not_configured'

export interface IntegrationDef {
  id: string
  name: string
  category: IntegrationCategory
  /** All must be set for the integration to count as configured. */
  requiredEnv: string[]
  purpose: string
  /** Platform approvals the owner must obtain; shown in the UI, never faked. */
  externalRequirements?: string
}

export const INTEGRATIONS: IntegrationDef[] = [
  { id: 'supabase', name: 'Supabase', category: 'core',
    requiredEnv: ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'],
    purpose: 'Database, authentication, storage' },
  { id: 'credential_vault', name: 'Credential vault', category: 'security',
    requiredEnv: ['CREDENTIALS_ENCRYPTION_KEY'],
    purpose: 'AES-256-GCM encryption of social OAuth tokens at rest' },
  { id: 'anthropic', name: 'Anthropic (Claude)', category: 'ai',
    requiredEnv: ['ANTHROPIC_API_KEY'], purpose: 'Agent reasoning, content drafting, safety classification' },
  { id: 'openai', name: 'OpenAI', category: 'ai',
    requiredEnv: ['OPENAI_API_KEY'], purpose: 'Optional secondary model provider' },
  { id: 'image_generation', name: 'Image generation', category: 'media',
    requiredEnv: ['OPENAI_API_KEY'],
    purpose: 'Character imagery via the OpenAI Images API (AI_IMAGE_PROVIDER=openai, the default when the key is set)' },
  { id: 'video_generation', name: 'Video generation', category: 'media',
    requiredEnv: ['AI_VIDEO_PROVIDER', 'OPENAI_API_KEY'],
    purpose: 'Short-form video via the OpenAI Videos API (opt in with AI_VIDEO_PROVIDER=openai)' },
  { id: 'cron', name: 'Scheduled jobs', category: 'security',
    requiredEnv: ['CRON_SECRET'], purpose: 'Authenticates Vercel Cron calls to /api/cron/* (fail closed when unset)' },
  { id: 'meta', name: 'Instagram (Meta)', category: 'social',
    requiredEnv: ['META_APP_ID', 'META_APP_SECRET'], purpose: 'Instagram publishing and insights',
    externalRequirements: 'Instagram Business/Creator account linked to a Facebook Page, and Meta app review for publishing permissions.' },
  { id: 'tiktok', name: 'TikTok', category: 'social',
    requiredEnv: ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET'], purpose: 'TikTok Content Posting API',
    externalRequirements: 'TikTok developer app; the Content Posting API requires an app audit before public posting.' },
  { id: 'youtube', name: 'YouTube (Google)', category: 'social',
    requiredEnv: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'], purpose: 'YouTube uploads and analytics',
    externalRequirements: 'Google Cloud project with the YouTube Data API; unverified projects can only upload private videos.' },
  { id: 'x', name: 'X', category: 'social',
    requiredEnv: ['X_CLIENT_ID', 'X_CLIENT_SECRET'], purpose: 'Posting to X',
    externalRequirements: 'X developer account; write access depends on the API access tier.' },
  { id: 'stripe', name: 'Stripe', category: 'payments',
    requiredEnv: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'], purpose: 'Records paid subscription/product revenue from verified webhooks' },
  { id: 'resend', name: 'Resend', category: 'email',
    requiredEnv: ['RESEND_API_KEY'], purpose: 'Sends brand outreach emails a human has approved' },
]

export interface IntegrationState {
  id: string
  name: string
  category: IntegrationCategory
  status: IntegrationStatus
  /** Names (never values) of missing env vars. */
  missing: string[]
  purpose: string
  externalRequirements?: string
}

export function integrationStates(env: Record<string, string | undefined>): IntegrationState[] {
  return INTEGRATIONS.map(def => {
    const missing = def.requiredEnv.filter(k => !env[k] || env[k]!.trim() === '')
    return {
      id: def.id,
      name: def.name,
      category: def.category,
      status: missing.length === 0 ? 'configured' : 'not_configured',
      missing,
      purpose: def.purpose,
      externalRequirements: def.externalRequirements,
    }
  })
}

export function integrationState(id: string, env: Record<string, string | undefined>): IntegrationState {
  const s = integrationStates(env).find(i => i.id === id)
  if (!s) throw new Error(`unknown integration: ${id}`)
  return s
}
