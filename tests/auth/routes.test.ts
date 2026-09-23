import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyRoute, safeNextPath, parseEmailList, isEmailAllowed } from '@/lib/auth/routes'

test('application pages require a signed-in user', () => {
  for (const p of ['/dashboard', '/characters', '/characters/new', '/content/approvals', '/social/instagram',
    '/agents', '/agents/logs', '/growth/analytics', '/crm/pipeline', '/monetisation/affiliate', '/settings', '/unknown-page']) {
    assert.equal(classifyRoute(p), 'user', p)
  }
})

test('ops pages and legacy APIs require a platform admin (default-deny for /api)', () => {
  for (const p of ['/ops', '/ops/stream', '/ops/share/abc', '/api/todos', '/api/agents/control', '/api/panic',
    '/api/git/revert', '/api/health', '/api/god-chat', '/api/some-new-route']) {
    assert.equal(classifyRoute(p, 'POST'), 'ops', p)
    assert.equal(classifyRoute(p, 'GET'), 'ops', p)
  }
})

test('public routes are explicit and method-scoped', () => {
  assert.equal(classifyRoute('/login'), 'public')
  assert.equal(classifyRoute('/auth/callback'), 'public')
  assert.equal(classifyRoute('/'), 'public')
  assert.equal(classifyRoute('/topics/some-article'), 'public')
  assert.equal(classifyRoute('/api/subscribe', 'POST'), 'public')
  assert.equal(classifyRoute('/api/subscribe', 'GET'), 'ops', 'listing subscribers is not public')
  assert.equal(classifyRoute('/api/webhooks/github', 'POST'), 'public')
  assert.equal(classifyRoute('/api/webhooks/github', 'GET'), 'ops')
  assert.equal(classifyRoute('/api/og', 'GET'), 'public')
})

test('prefix rules do not leak to look-alike paths', () => {
  assert.equal(classifyRoute('/loginx'), 'user')
  assert.equal(classifyRoute('/opsx'), 'user')
  assert.equal(classifyRoute('/api/subscribe-all', 'POST'), 'ops')
  assert.equal(classifyRoute('/about/'), 'public', 'trailing slash normalised')
})

test('product APIs under /api/v1 require a user (workspace-scoped in handlers)', () => {
  assert.equal(classifyRoute('/api/v1/characters'), 'user')
})

test('safeNextPath blocks open redirects', () => {
  for (const bad of ['//evil.com', 'https://evil.com', '/\\evil.com', 'javascript:alert(1)', 'evil.com', '/login', '/auth/callback', '/logout', '/\u0000x', '']) {
    assert.equal(safeNextPath(bad), '/dashboard', JSON.stringify(bad))
  }
  assert.equal(safeNextPath('/crm/pipeline?x=1#y'), '/crm/pipeline?x=1#y')
  assert.equal(safeNextPath(undefined, '/ops'), '/ops')
})

test('email allow-list: empty allows all, otherwise exact case-insensitive match', () => {
  const none = parseEmailList(undefined)
  assert.equal(isEmailAllowed('a@b.co', none), true)
  const list = parseEmailList(' Owner@Example.com , ,not-an-email')
  assert.deepEqual([...list], ['owner@example.com'])
  assert.equal(isEmailAllowed('OWNER@example.com', list), true)
  assert.equal(isEmailAllowed('other@example.com', list), false)
  assert.equal(isEmailAllowed(null, list), false)
})
