// Exercises the real proxy.ts with unauthenticated and forged-session requests.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

// Unreachable Supabase: any attempt to validate a (forged) session fails closed.
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:9'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'

let proxy: (req: NextRequest) => Promise<Response>
before(async () => { ({ proxy } = await import('@/proxy')) })

const req = (path: string, init: { method?: string; cookie?: string } = {}) =>
  new NextRequest(new URL(path, 'http://localhost:3000'), {
    method: init.method ?? 'GET',
    headers: init.cookie ? { cookie: init.cookie } : {},
  })

test('unauthenticated page requests redirect to /login with next', async () => {
  for (const p of ['/dashboard', '/characters', '/settings', '/ops']) {
    const res = await proxy(req(p))
    assert.equal(res.status, 307, p)
    const loc = new URL(res.headers.get('location')!)
    assert.equal(loc.pathname, '/login')
    assert.equal(loc.searchParams.get('next'), p)
  }
})

test('unauthenticated API requests get 401 JSON', async () => {
  for (const [p, m] of [['/api/todos', 'POST'], ['/api/todos', 'DELETE'], ['/api/agents/control', 'POST'],
    ['/api/panic', 'POST'], ['/api/git/revert', 'POST'], ['/api/subscribe', 'GET'], ['/api/health', 'GET']] as const) {
    const res = await proxy(req(p, { method: m }))
    assert.equal(res.status, 401, `${m} ${p}`)
    assert.deepEqual(await res.json(), { error: 'authentication required' })
  }
})

test('a forged session cookie is rejected (validated with the Auth server, fails closed)', async () => {
  const forged = 'sb-127-auth-token=base64-eyJhY2Nlc3NfdG9rZW4iOiJmb3JnZWQiLCJ1c2VyIjp7ImlkIjoieCJ9fQ'
  const res = await proxy(req('/api/agents/control', { method: 'POST', cookie: forged }))
  assert.equal(res.status, 401)
  const page = await proxy(req('/dashboard', { cookie: forged }))
  assert.equal(page.status, 307)
})

test('public routes pass through', async () => {
  for (const [p, m] of [['/login', 'GET'], ['/api/subscribe', 'POST'], ['/api/webhooks/github', 'POST'], ['/privacy', 'GET']] as const) {
    const res = await proxy(req(p, { method: m }))
    assert.equal(res.status, 200, `${m} ${p}`)
    assert.equal(res.headers.get('x-middleware-next'), '1', `${m} ${p} should continue`)
  }
})
