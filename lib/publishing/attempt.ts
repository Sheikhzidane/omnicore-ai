import { decidePublish } from '@/lib/safety/approval'
import { missingDisclosures } from '@/lib/safety/disclosure'
import type { CharacterRow, ContentItemsRow, ContentVersionsRow, PublishingJobRow, PublishingPolicyRow, SocialAccountsRow } from '@/types/database'
import type { Env, FetchFn, OAuthTokens, PublishMedia, SocialProvider } from '@/lib/social/providers/types'
import { SocialApiError, UnsupportedPublishError } from '@/lib/social/providers/http'

/**
 * One publishing attempt for a claimed job. Every gate is re-checked at
 * publish time — the approval authorised THIS version for THIS account, and
 * policy, safety, disclosure and rate limits may have changed since.
 */

export interface AttemptContext {
  job: Pick<PublishingJobRow, 'id' | 'approval_id' | 'auto_approved_reason' | 'platform'>
  item: Pick<ContentItemsRow, 'id' | 'status' | 'safety_status' | 'disclosure_applied' | 'is_sponsored' | 'format' | 'title' | 'current_version'>
  version: Pick<ContentVersionsRow, 'version' | 'caption' | 'script' | 'hashtags'> | null
  approvedVersion: number | null
  media: PublishMedia[]
  account: Pick<SocialAccountsRow, 'status' | 'platform'>
  policy: Pick<PublishingPolicyRow, 'publishing_enabled' | 'requires_human_approval' | 'max_posts_per_day' | 'min_minutes_between_posts' | 'ai_label_required'>
  character: Pick<CharacterRow, 'status' | 'approval_mode' | 'ai_disclosure_mode' | 'disclosure_text'>
  postsInLast24h: number
  lastPostAt: Date | null
  provider: SocialProvider | null
  tokens: () => Promise<OAuthTokens>
}

export type AttemptOutcome =
  | { kind: 'published'; externalPostId: string; url: string | null; summary: Record<string, unknown> }
  | { kind: 'retry'; error: string }
  | { kind: 'blocked'; reasons: string[] }

export function composeCaption(v: Pick<ContentVersionsRow, 'caption' | 'hashtags'>): string {
  const tags = (v.hashtags ?? []).map(h => (h.startsWith('#') ? h : `#${h}`)).filter(h => !v.caption?.includes(h))
  return [v.caption?.trim() ?? '', tags.join(' ')].filter(Boolean).join('\n\n')
}

export async function attemptPublish(c: AttemptContext, env: Env, f: FetchFn, now = new Date()): Promise<AttemptOutcome> {
  if (!c.job.approval_id && !c.job.auto_approved_reason) return { kind: 'blocked', reasons: ['Job has no approval.'] }
  if (!c.provider) return { kind: 'blocked', reasons: [`No provider for platform "${c.job.platform}".`] }
  if (!c.version) return { kind: 'blocked', reasons: ['Content has no version to publish.'] }
  if (c.approvedVersion !== null && c.approvedVersion !== c.item.current_version) {
    return { kind: 'blocked', reasons: [`Content changed after approval (approved v${c.approvedVersion}, now v${c.item.current_version}); re-approval required.`] }
  }
  if (!['scheduled', 'publishing'].includes(c.item.status)) return { kind: 'blocked', reasons: [`Content status is "${c.item.status}".`] }
  if (c.item.safety_status !== 'passed') return { kind: 'blocked', reasons: [`Safety status is "${c.item.safety_status}".`] }
  if (!c.provider.configured(env)) return { kind: 'blocked', reasons: [`${c.provider.displayName} app credentials are not configured.`] }

  const caption = composeCaption(c.version)
  const decision = decidePublish({
    character: c.character, policy: c.policy, safetyStatus: c.item.safety_status,
    disclosureMissing: missingDisclosures({ caption, character: c.character, platform: c.policy, isSponsored: c.item.is_sponsored }),
    isSponsored: c.item.is_sponsored, accountConnected: c.account.status === 'connected',
    postsInLast24h: c.postsInLast24h, lastPostAt: c.lastPostAt, now,
  })
  if (!decision.allowed) {
    const rate = decision.reasons.filter(r => /limit|interval/i.test(r))
    // Rate limits are temporary: retry later. Everything else needs a human.
    if (rate.length && rate.length === decision.reasons.filter(r => !/approval/i.test(r)).length) return { kind: 'retry', error: rate.join(' ') }
    return { kind: 'blocked', reasons: decision.reasons }
  }
  if (!c.job.approval_id && decision.requiresHumanApproval) return { kind: 'blocked', reasons: decision.reasons }

  try {
    const tokens = await c.tokens()
    const out = await c.provider.publish(tokens, {
      caption, title: c.item.title, format: c.item.format, media: c.media, isSponsored: c.item.is_sponsored, aiGenerated: true,
    }, env, f)
    return { kind: 'published', ...out }
  } catch (e) {
    if (e instanceof UnsupportedPublishError) return { kind: 'blocked', reasons: [e.message] }
    if (e instanceof SocialApiError && !e.retryable) return { kind: 'blocked', reasons: [e.message] }
    if ((e as Error).name === 'ReconnectRequiredError') return { kind: 'blocked', reasons: [(e as Error).message] }
    return { kind: 'retry', error: (e as Error).message.slice(0, 1000) }
  }
}
