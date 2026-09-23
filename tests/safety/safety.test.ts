import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyDisclosure, missingDisclosures } from '@/lib/safety/disclosure'
import { decidePublish, type PublishContext } from '@/lib/safety/approval'
import { checkAudience } from '@/lib/safety/audience'
import { parsePolicy, HARD_BLOCKED_CATEGORIES, DEFAULT_POLICY } from '@/lib/safety/policy'
import { isProhibited, PROHIBITED_AUTOMATION } from '@/lib/safety/prohibited'

const character = { ai_disclosure_mode: 'always' as const, disclosure_text: 'AI-generated virtual character' }
const platform = { ai_label_required: true }

test('disclosure: AI label and #ad are appended, idempotently', () => {
  const out = applyDisclosure({ caption: 'New drop!', character, platform, isSponsored: true })
  assert.match(out, /#ad/)
  assert.match(out, /AI-generated virtual character/)
  assert.equal(applyDisclosure({ caption: out, character, platform, isSponsored: true }), out)
  assert.deepEqual(missingDisclosures({ caption: out, character, platform, isSponsored: true }), [])
})

test('disclosure: missing labels are reported; bio_only still labels when the platform requires it', () => {
  assert.deepEqual(missingDisclosures({ caption: 'hi', character, platform, isSponsored: true }), ['sponsorship', 'ai_character'])
  const bioOnly = { ...character, ai_disclosure_mode: 'bio_only' as const }
  assert.deepEqual(missingDisclosures({ caption: 'hi', character: bioOnly, platform, isSponsored: false }), ['ai_character'])
  assert.deepEqual(missingDisclosures({ caption: 'hi', character: bioOnly, platform: { ai_label_required: false }, isSponsored: false }), [])
})

const base: PublishContext = {
  character: { approval_mode: 'auto_low_risk', status: 'active' },
  policy: { publishing_enabled: true, requires_human_approval: false, max_posts_per_day: 3, min_minutes_between_posts: 60 },
  safetyStatus: 'passed', disclosureMissing: [], isSponsored: false, accountConnected: true,
  postsInLast24h: 0, lastPostAt: null, now: new Date('2026-09-23T12:00:00Z'),
}

test('publish gate: auto-publish only when every condition holds', () => {
  const ok = decidePublish(base)
  assert.deepEqual([ok.allowed, ok.requiresHumanApproval], [true, false])
})

test('publish gate: human approval is the default and cannot be skipped for risky content', () => {
  assert.equal(decidePublish({ ...base, character: { approval_mode: 'human_required', status: 'active' } }).requiresHumanApproval, true)
  assert.equal(decidePublish({ ...base, policy: { ...base.policy, requires_human_approval: true } }).requiresHumanApproval, true)
  assert.equal(decidePublish({ ...base, isSponsored: true }).requiresHumanApproval, true)
  assert.equal(decidePublish({ ...base, safetyStatus: 'flagged' }).requiresHumanApproval, true)
})

test('publish gate: hard blockers', () => {
  const blocked: Array<Partial<PublishContext>> = [
    { accountConnected: false },
    { policy: { ...base.policy, publishing_enabled: false } },
    { character: { approval_mode: 'auto_low_risk', status: 'paused' } },
    { safetyStatus: 'blocked' },
    { safetyStatus: 'unchecked' },
    { disclosureMissing: ['ai_character'] },
    { postsInLast24h: 3 },
    { lastPostAt: new Date('2026-09-23T11:30:00Z') },
  ]
  for (const b of blocked) assert.equal(decidePublish({ ...base, ...b }).allowed, false, JSON.stringify(b))
})

test('age gating: mature content needs an 18+ character on a platform that can restrict it', () => {
  assert.equal(checkAudience({ age_restricted: false, min_audience_age: 13 }, 'general', false).allowed, true)
  assert.equal(checkAudience({ age_restricted: false, min_audience_age: 13 }, 'mature', true).allowed, false)
  assert.equal(checkAudience({ age_restricted: true, min_audience_age: 18 }, 'mature', false).allowed, false)
  assert.equal(checkAudience({ age_restricted: true, min_audience_age: 18 }, 'mature', true).allowed, true)
})

test('content policy: hard blocks cannot be removed; unknown keys rejected', () => {
  const p = parsePolicy({ hardBlocked: [], blockedTopics: ['gambling'] })
  assert.deepEqual(p.hardBlocked, [...HARD_BLOCKED_CATEGORIES])
  assert.ok(DEFAULT_POLICY.hardBlocked!.includes('sexual_content_involving_minors'))
  assert.throws(() => parsePolicy({ allowEverything: true }))
})

test('prohibited automation includes spam, DMs, fake engagement and limit evasion', () => {
  for (const k of ['mass_dm', 'unsolicited_dm', 'fake_engagement', 'rate_limit_evasion', 'deceptive_impersonation']) {
    assert.ok(isProhibited(k), k)
  }
  assert.equal(isProhibited('publish_post'), false)
  assert.ok(Object.keys(PROHIBITED_AUTOMATION).length >= 8)
})
