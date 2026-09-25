import { createInstagramProvider } from './instagram'
import { createTikTokProvider } from './tiktok'
import { createYouTubeProvider } from './youtube'
import { createXProvider } from './x'
import type { SocialProvider } from './types'

export * from './types'
export { SocialApiError, UnsupportedPublishError } from './http'

/**
 * Built-in providers. New platforms register here with the same contract; the
 * database accepts any provider id matching ^[a-z][a-z0-9_]{0,31}$.
 */
export const SOCIAL_PROVIDERS: Record<string, SocialProvider> = {
  instagram: createInstagramProvider(),
  tiktok: createTikTokProvider(),
  youtube: createYouTubeProvider(),
  x: createXProvider(),
}

export const SOCIAL_PROVIDER_IDS = Object.keys(SOCIAL_PROVIDERS)

export function getSocialProvider(platform: string): SocialProvider | null {
  return Object.hasOwn(SOCIAL_PROVIDERS, platform) ? SOCIAL_PROVIDERS[platform] : null
}
