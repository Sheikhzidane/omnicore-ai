import type { SocialPlatform } from '@/types/database'
import { integrationState, type IntegrationState } from '@/lib/config/integrations'

/**
 * Social platform adapter contract. Phase 1 ships the interface and honest
 * "not connected" implementations only: no OAuth flow exists yet, so every
 * account is DISCONNECTED and publish()/fetchMetrics() throw. Real adapters
 * (later phases) must keep the same guarantees:
 *   - tokens are decrypted server-side only (lib/secrets/credentials.ts)
 *   - platform rate limits are honoured, never evaded
 *   - no DMs, follows or engagement actions exist in this interface at all
 */

export type ConnectionStatus = 'disconnected' | 'not_configured'

export interface PublishRequest {
  caption: string
  mediaUrls: string[]
  /** Must already include AI + sponsorship disclosure (lib/safety/disclosure.ts). */
  disclosureApplied: true
}

export interface PublishResult { externalPostId: string; url: string }

export interface SocialAdapter {
  platform: SocialPlatform
  displayName: string
  integrationId: string
  /** Deliberately limited to publishing and reading own metrics. */
  capabilities: readonly ('publish' | 'read_own_metrics')[]
  status(env: Record<string, string | undefined>): { connection: ConnectionStatus; integration: IntegrationState }
  publish(req: PublishRequest): Promise<PublishResult>
  fetchMetrics(): Promise<never>
}

export class NotConnectedError extends Error {
  constructor(platform: SocialPlatform) {
    super(`${platform}: account not connected — no publishing is possible until OAuth is completed`)
    this.name = 'NotConnectedError'
  }
}

function disconnectedAdapter(platform: SocialPlatform, displayName: string, integrationId: string): SocialAdapter {
  return {
    platform,
    displayName,
    integrationId,
    capabilities: ['publish', 'read_own_metrics'] as const,
    status(env) {
      const integration = integrationState(integrationId, env)
      return { connection: integration.status === 'configured' ? 'disconnected' : 'not_configured', integration }
    },
    async publish() { throw new NotConnectedError(platform) },
    async fetchMetrics() { throw new NotConnectedError(platform) },
  }
}

export const SOCIAL_ADAPTERS: Record<SocialPlatform, SocialAdapter> = {
  instagram: disconnectedAdapter('instagram', 'Instagram', 'meta'),
  tiktok:    disconnectedAdapter('tiktok', 'TikTok', 'tiktok'),
  youtube:   disconnectedAdapter('youtube', 'YouTube', 'youtube'),
  x:         disconnectedAdapter('x', 'X', 'x'),
}

export const SOCIAL_PLATFORMS = Object.keys(SOCIAL_ADAPTERS) as SocialPlatform[]
