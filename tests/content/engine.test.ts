import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assessContent, claimsToBeHuman, type AssessInput } from '@/lib/content/safety'
import { DEFAULT_POLICY, parsePolicy } from '@/lib/safety/policy'
import { zonedToUtc, isValidTimeZone, publishIdempotencyKey } from '@/lib/scheduling/time'
import { attemptPublish, composeCaption, type AttemptContext } from '@/lib/publishing/attempt'
import { canDecide } from '@/lib/approvals/rules'
import { buildObjectPath, pathBelongsTo, sanitizeFileName, validateUpload } from '@/lib/storage/buckets'
import { engagementRate, followerGrowth, totals, latestPerDay, rankContent } from '@/lib/analytics/metrics'
import { summarise, parseAmountToCents } from '@/lib/monetisation/finance'
import { SocialApiError, UnsupportedPublishError, type SocialProvider } from '@/lib/social/providers'

const base: AssessInput = {
  text: 'New look for autumn 🍂\n\nAI-generated virtual character', rating: 'general',
  character: { age_restricted: false, min_audience_age: 13 }, platformSupportsAgeRestriction: false,
  policy: DEFAULT_POLICY, blockedTopics: [], moderation: { provider: 'test', flagged: false, categories: [] },
}

test('safety: clean content passes only when moderation actually ran', () => {
  assert.equal(assessContent(base).status, 'passed')
  const noMod = assessContent({ ...base, moderation: null })
  assert.equal(noMod.status, 'flagged')
  assert.equal(noMod.moderation, 'unavailable')
  assert.match(noMod.reasons.join(' '), /human must review/)
})

test('safety: claiming to be human is blocked', () => {
  for (const t of ["I'm a real person, promise!", 'i am not an AI', 'This is really me personally typing']) {
    assert.equal(claimsToBeHuman(t), true, t)
    assert.equal(assessContent({ ...base, text: t }).status, 'blocked', t)
  }
  assert.equal(claimsToBeHuman('I am an AI character and proud of it'), false)
})

test('safety: blocked topics block, review terms flag, whole words only', () => {
  const policy = parsePolicy({ blockedTopics: ['gambling'], reviewTerms: ['giveaway'] })
  assert.equal(assessContent({ ...base, policy, text: 'Online gambling tips' }).status, 'blocked')
  assert.equal(assessContent({ ...base, policy, text: 'Big giveaway today' }).status, 'flagged')
  assert.equal(assessContent({ ...base, policy, text: 'Giveaways-free zone: ungambling' }).status, 'passed')
  assert.equal(assessContent({ ...base, blockedTopics: ['politics'], text: 'Talking POLITICS today' }).status, 'blocked')
})

test('safety: health/finance claims need a disclaimer', () => {
  assert.equal(assessContent({ ...base, text: 'This supplement cures everything' }).status, 'flagged')
  assert.equal(assessContent({ ...base, text: 'This supplement helps me. Not medical advice — consult your doctor.' }).status, 'passed')
  assert.equal(assessContent({ ...base, text: 'Guaranteed profit with crypto trading' }).status, 'flagged')
})

test('safety: mature content and hard moderation categories are blocked', () => {
  assert.equal(assessContent({ ...base, rating: 'mature' }).status, 'blocked')
  assert.equal(assessContent({ ...base, moderation: { provider: 't', flagged: true, categories: ['sexual/minors'] } }).status, 'blocked')
  assert.equal(assessContent({ ...base, moderation: { provider: 't', flagged: true, categories: ['harassment'] } }).status, 'flagged')
})

test('scheduling: wall-clock time in a zone becomes the right UTC instant, across DST', () => {
  assert.equal(zonedToUtc('2026-01-15', '09:00', 'Europe/London'), '2026-01-15T09:00:00.000Z')
  assert.equal(zonedToUtc('2026-07-15', '09:00', 'Europe/London'), '2026-07-15T08:00:00.000Z')
  assert.equal(zonedToUtc('2026-07-15', '09:00', 'Asia/Dhaka'), '2026-07-15T03:00:00.000Z')
  assert.equal(zonedToUtc('2026-07-15', '09:00', 'America/New_York'), '2026-07-15T13:00:00.000Z')
  // Spring-forward gap (02:30 does not exist in New York on 2026-03-08) moves forward.
  assert.equal(zonedToUtc('2026-03-08', '02:30', 'America/New_York'), '2026-03-08T07:30:00.000Z')
  // Fall-back ambiguity resolves to the earlier instant.
  assert.equal(zonedToUtc('2026-11-01', '01:30', 'America/New_York'), '2026-11-01T05:30:00.000Z')
  assert.equal(isValidTimeZone('Mars/Olympus'), false)
  assert.throws(() => zonedToUtc('2026-01-01', '9am', 'UTC'))
  assert.equal(publishIdempotencyKey('a', 'b'), 'publish:a:b')
})

function provider(over: Partial<SocialProvider> = {}): SocialProvider {
  return {
    platform: 'instagram', displayName: 'Instagram', integrationId: 'meta', scopes: ['s'], usesPkce: false, requirements: ['r'],
    capabilities: { publishImage: true, publishVideo: true, publishText: false, metrics: true, webhooks: true, replyToComments: true, ageRestriction: false },
    configured: () => true, authorizationUrl: () => '', exchangeCode: async () => ({ accessToken: '', scopes: [] }),
    fetchIdentity: async () => ({ externalAccountId: '1', handle: null, displayName: null }),
    publish: async () => ({ externalPostId: 'P1', url: 'https://instagram.com/p/1', summary: {} }),
    fetchPostMetrics: async () => ({}), ...over,
  }
}

const ctx = (over: Partial<AttemptContext> = {}): AttemptContext => ({
  job: { id: 'j', approval_id: 'ap', auto_approved_reason: null, platform: 'instagram' },
  item: { id: 'i', status: 'scheduled', safety_status: 'passed', disclosure_applied: true, is_sponsored: false, format: 'post', title: 'T', current_version: 2 },
  version: { version: 2, caption: 'Hello\n\nAI-generated virtual character', script: null, hashtags: ['autumn'] },
  approvedVersion: 2, media: [{ kind: 'image', url: 'https://s/x.jpg', mimeType: 'image/jpeg' }],
  account: { status: 'connected', platform: 'instagram' },
  policy: { publishing_enabled: true, requires_human_approval: true, max_posts_per_day: 3, min_minutes_between_posts: 60, ai_label_required: true },
  character: { status: 'active', approval_mode: 'human_required', ai_disclosure_mode: 'always', disclosure_text: 'AI-generated virtual character' },
  postsInLast24h: 0, lastPostAt: null, provider: provider(), tokens: async () => ({ accessToken: 't', scopes: [] }), ...over,
})

test('publish attempt: approved, compliant content publishes', async () => {
  const out = await attemptPublish(ctx(), {}, fetch)
  assert.equal(out.kind, 'published')
  assert.equal(composeCaption({ caption: 'Hi #autumn', hashtags: ['autumn', 'fall'] }), 'Hi #autumn\n\n#fall')
})

test('publish attempt: every gate is re-checked at publish time', async () => {
  const blocked = async (c: AttemptContext) => { const o = await attemptPublish(c, {}, fetch); assert.equal(o.kind, 'blocked', JSON.stringify(o)); return o }
  await blocked(ctx({ approvedVersion: 1 }))
  await blocked(ctx({ job: { id: 'j', approval_id: null, auto_approved_reason: null, platform: 'instagram' } }))
  await blocked(ctx({ account: { status: 'revoked', platform: 'instagram' } }))
  await blocked(ctx({ policy: { ...ctx().policy, publishing_enabled: false } }))
  await blocked(ctx({ version: { version: 2, caption: 'No disclosure here', script: null, hashtags: [] } }))
  await blocked(ctx({ item: { ...ctx().item, safety_status: 'flagged' } }))
  await blocked(ctx({ provider: null }))
  await blocked(ctx({ provider: provider({ configured: () => false }) }))
  await blocked(ctx({ provider: provider({ publish: async () => { throw new UnsupportedPublishError('instagram', 'carousel') } }) }))
  await blocked(ctx({ provider: provider({ publish: async () => { throw new SocialApiError('instagram', 400, 'bad media', false) } }) }))
})

test('publish attempt: rate limits and transient errors retry; nothing auto-publishes without approval when a human is required', async () => {
  assert.equal((await attemptPublish(ctx({ postsInLast24h: 3 }), {}, fetch)).kind, 'retry')
  assert.equal((await attemptPublish(ctx({ lastPostAt: new Date(Date.now() - 10 * 60_000) }), {}, fetch)).kind, 'retry')
  assert.equal((await attemptPublish(ctx({ provider: provider({ publish: async () => { throw new SocialApiError('instagram', 503, 'down', true) } }) }), {}, fetch)).kind, 'retry')
  const auto = ctx({ job: { id: 'j', approval_id: null, auto_approved_reason: 'policy', platform: 'instagram' } })
  assert.equal((await attemptPublish(auto, {}, fetch)).kind, 'blocked', 'auto job refused when policy requires a human')
})

test('approvals: role and risk rules', () => {
  const a = { status: 'AWAITING_APPROVAL' as const, risk_level: 'medium' as const, action_type: 'publish_content' as const, expires_at: null }
  assert.deepEqual(canDecide(a, 'editor'), { ok: true })
  assert.equal(canDecide(a, 'viewer').ok, false)
  assert.equal(canDecide({ ...a, risk_level: 'high' }, 'editor').ok, false)
  assert.equal(canDecide({ ...a, risk_level: 'high' }, 'admin').ok, true)
  assert.equal(canDecide({ ...a, action_type: 'financial_action' }, 'editor').ok, false)
  assert.equal(canDecide({ ...a, status: 'APPROVED' }, 'owner').ok, false)
  assert.equal(canDecide({ ...a, expires_at: '2020-01-01T00:00:00Z' }, 'owner').ok, false)
})

test('storage: paths stay inside the workspace; type and size enforced', () => {
  const ws = '0b6f7c1e-8d1a-4c4e-9a53-5b8f0c2d1e11', ch = '7c1e0b6f-1a8d-4e4c-853a-2d1e115b8f0c'
  const p = buildObjectPath(ws, ch, '../../etc/passwd', 'f3a1c2d4-0000-4000-8000-000000000000')
  assert.equal(p, `${ws}/${ch}/f3a1c2d4-0000-4000-8000-000000000000-passwd`)
  assert.ok(pathBelongsTo(p, ws))
  assert.equal(pathBelongsTo(`${ws}/../other/x`, ws), false)
  assert.equal(pathBelongsTo(`other/${ch}/x`, ws), false)
  assert.throws(() => buildObjectPath('not-a-uuid', ch, 'a.png'))
  assert.equal(sanitizeFileName('my photo (1).PNG'), 'my-photo-1-.PNG')
  assert.deepEqual(validateUpload('reference-images', 'image/png', 1000), { ok: true })
  assert.equal(validateUpload('reference-images', 'video/mp4', 1000).ok, false)
  assert.equal(validateUpload('character-assets', 'image/png', 21 * 1024 * 1024).ok, false)
  assert.equal(validateUpload('character-assets', 'image/svg+xml', 10).ok, false, 'SVG (script-capable) is never accepted')
})

test('analytics: missing data stays missing; no invented numbers', () => {
  const rows = [
    { day: '2026-09-01', followers: 100, reach: 1000, impressions: null, views: null, likes: 50, comments: 5, shares: null, saves: null },
    { day: '2026-09-02', followers: null, reach: null, impressions: null, views: null, likes: null, comments: null, shares: null, saves: null },
    { day: '2026-09-03', followers: 130, reach: 1000, impressions: null, views: null, likes: 45, comments: 0, shares: 0, saves: 0 },
  ]
  const t = totals(rows)
  assert.equal(t.reach, 2000)
  assert.equal(t.impressions, null)
  assert.equal(t.interactions, 100)
  assert.equal(engagementRate(t), 0.05)
  assert.deepEqual(followerGrowth(rows), { start: 100, end: 130, change: 30, pct: 0.3 })
  assert.equal(followerGrowth(rows.slice(0, 2)), null)
  assert.equal(engagementRate(totals([])), null)
  const empty = { day: '2026-09-01', followers: null, reach: null, impressions: null, views: null, likes: null, comments: null, shares: null, saves: null }
  assert.deepEqual(rankContent([{ id: 'x', title: 'X', platform: 'x', rows: [empty] }]), [], 'content without data is not ranked')
  const snaps = latestPerDay([{ day: 'd', captured_at: '1', v: 1 }, { day: 'd', captured_at: '2', v: 2 }], () => 'k')
  assert.deepEqual(snaps.map(s => s.v), [2])
})

test('finance: per-currency profit and ROI in integer cents', () => {
  const s = summarise(
    [{ amount_cents: 50000, currency: 'usd', status: 'received', source_type: 'sponsorship', character_id: null },
     { amount_cents: 1000, currency: 'USD', status: 'expected', source_type: 'affiliate', character_id: null },
     { amount_cents: 2000, currency: 'EUR', status: 'received', source_type: 'product', character_id: null }],
    [{ amount_cents: 10000, currency: 'USD', category: 'ai_compute', character_id: null }],
  )
  const usd = s.find(x => x.currency === 'USD')!
  assert.equal(usd.profitCents, 40000)
  assert.equal(usd.roi, 4)
  assert.equal(usd.expectedCents, 1000, 'expected revenue is not counted as profit')
  assert.equal(s.find(x => x.currency === 'EUR')!.roi, null, 'no expenses → ROI undefined, not infinite')
  assert.equal(parseAmountToCents('120.5'), 12050)
  assert.equal(parseAmountToCents('0,07'), 7)
  assert.throws(() => parseAmountToCents('-5'))
})
