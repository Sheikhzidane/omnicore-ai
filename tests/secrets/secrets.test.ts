import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { encryptSecret, decryptSecret, loadKey, CredentialVaultNotConfiguredError } from '@/lib/secrets/credentials'
import { integrationStates, INTEGRATIONS } from '@/lib/config/integrations'
import { SOCIAL_PROVIDERS } from '@/lib/social/providers'

const key = randomBytes(32)

test('credential vault: round trip, random IV, versioned envelope', () => {
  const a = encryptSecret('oauth-access-token', key)
  const b = encryptSecret('oauth-access-token', key)
  assert.notEqual(a, b, 'same plaintext must not produce the same ciphertext')
  assert.match(a, /^v1\./)
  assert.ok(!a.includes('oauth-access-token'))
  assert.equal(decryptSecret(a, key), 'oauth-access-token')
})

test('credential vault: tampering and wrong keys are detected', () => {
  const env = encryptSecret('secret', key)
  const parts = env.split('.')
  const flipped = Buffer.from(parts[3], 'base64url'); flipped[0] ^= 1
  assert.throws(() => decryptSecret([...parts.slice(0, 3), flipped.toString('base64url')].join('.'), key))
  assert.throws(() => decryptSecret(env, randomBytes(32)))
  assert.throws(() => decryptSecret('v0.a.b.c', key))
})

test('credential vault: missing or malformed key → not configured', () => {
  assert.throws(() => loadKey(undefined), CredentialVaultNotConfiguredError)
  assert.throws(() => loadKey(Buffer.from('short').toString('base64')), CredentialVaultNotConfiguredError)
  assert.equal(loadKey(key.toString('base64')).length, 32)
})

test('integrations: every required provider is registered', () => {
  const ids = INTEGRATIONS.map(i => i.id)
  for (const id of ['anthropic', 'openai', 'supabase', 'meta', 'tiktok', 'youtube', 'x', 'stripe', 'image_generation', 'video_generation']) {
    assert.ok(ids.includes(id), id)
  }
})

test('integrations: unset → NOT CONFIGURED with missing names only; values never exposed', () => {
  const states = integrationStates({})
  assert.ok(states.every(s => s.status === 'not_configured'))
  const env = { ANTHROPIC_API_KEY: 'sk-ant-super-secret' }
  const anthropic = integrationStates(env).find(s => s.id === 'anthropic')!
  assert.equal(anthropic.status, 'configured')
  assert.ok(!JSON.stringify(integrationStates(env)).includes('sk-ant-super-secret'), 'values must never appear in status')
  assert.equal(integrationStates({ ANTHROPIC_API_KEY: '   ' }).find(s => s.id === 'anthropic')!.status, 'not_configured')
})

test('social providers: unconfigured without app credentials; never build an auth URL without them', () => {
  for (const p of Object.values(SOCIAL_PROVIDERS)) {
    assert.equal(p.configured({}), false, p.platform)
    assert.throws(() => p.authorizationUrl({ state: 's', redirectUri: 'https://a/cb', codeChallenge: 'c' }, {}), p.platform)
  }
})
