/**
 * Social provider contract. Each implementation talks to ONE platform's
 * official API. Tokens are handed in by the caller (decrypted server-side by
 * lib/social/tokens.ts) and never logged, persisted in plain fields or put in
 * error messages. Providers expose only: OAuth, publishing own content, reading
 * own metrics, receiving webhooks and — where the platform allows — replying to
 * comments on own posts after human approval. No DMs to strangers, follows,
 * likes or other engagement automation exist in this interface.
 *
 * Status: IMPLEMENTED — EXTERNAL VERIFICATION REQUIRED. The request shapes
 * follow each platform's published API docs and are unit-tested against
 * recorded shapes; none has been exercised against the live service from
 * this repository.
 */

export type FetchFn = typeof fetch
export type Env = Record<string, string | undefined>

export interface OAuthTokens {
  accessToken: string
  refreshToken?: string
  /** ISO timestamp. */
  expiresAt?: string
  refreshExpiresAt?: string
  scopes: string[]
  /** Provider-specific ids needed for API calls (e.g. Instagram user id). Not secret. */
  accountRef?: string
}

export interface AccountIdentity {
  externalAccountId: string
  handle: string | null
  displayName: string | null
}

export interface PublishMedia {
  kind: 'image' | 'video'
  /** Short-lived signed HTTPS URL the platform (or we) can fetch. */
  url: string
  mimeType: string
  bytes?: number
}

export interface PublishInput {
  /** Final caption — AI and sponsorship disclosures already applied. */
  caption: string
  title?: string
  format: string
  media: PublishMedia[]
  isSponsored: boolean
  /** Always true for this product: every post is by an AI character. */
  aiGenerated: true
}

export interface PublishOutput {
  externalPostId: string
  url: string | null
  /** Sanitised, token-free summary of the provider response. */
  summary: Record<string, unknown>
}

export interface PostMetrics {
  views?: number
  reach?: number
  impressions?: number
  likes?: number
  comments?: number
  shares?: number
  saves?: number
}

export interface WebhookRequest {
  method: string
  headers: Headers
  rawBody: string
  url: URL
}

export interface ParsedWebhookEvent {
  eventId: string
  eventType: string
  externalAccountId?: string
  payload: Record<string, unknown>
}

export interface ProviderCapabilities {
  publishImage: boolean
  publishVideo: boolean
  publishText: boolean
  metrics: boolean
  webhooks: boolean
  replyToComments: boolean
  /** Can a post be restricted to adults on this platform through the API? */
  ageRestriction: boolean
}

export interface SocialProvider {
  platform: string
  displayName: string
  /** lib/config/integrations.ts id holding the app credentials. */
  integrationId: string
  capabilities: ProviderCapabilities
  /** Non-secret notes shown in the UI (app review, tier limits, defaults). */
  requirements: string[]
  scopes: string[]
  usesPkce: boolean
  configured(env: Env): boolean

  authorizationUrl(p: { state: string; redirectUri: string; codeChallenge?: string }, env: Env): string
  exchangeCode(p: { code: string; redirectUri: string; codeVerifier?: string }, env: Env, f: FetchFn): Promise<OAuthTokens>
  refresh?(tokens: OAuthTokens, env: Env, f: FetchFn): Promise<OAuthTokens>
  fetchIdentity(tokens: OAuthTokens, f: FetchFn): Promise<AccountIdentity>
  publish(tokens: OAuthTokens, input: PublishInput, env: Env, f: FetchFn): Promise<PublishOutput>
  fetchPostMetrics(tokens: OAuthTokens, externalPostId: string, f: FetchFn): Promise<PostMetrics>
  replyToComment?(tokens: OAuthTokens, commentExternalId: string, text: string, f: FetchFn): Promise<{ externalId: string }>

  /** Returns a response body for platform subscription handshakes (GET challenge / CRC), or null. */
  webhookHandshake?(req: WebhookRequest, env: Env): { status: number; body: string; contentType?: string } | null
  verifyWebhook?(req: WebhookRequest, env: Env): boolean
  parseWebhook?(body: unknown): ParsedWebhookEvent[]
}
