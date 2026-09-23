// Every API route handler must authorise inside the handler (defence in depth):
// a static audit of all route files plus runtime checks of privileged ones.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { NextRequest } from 'next/server'
import { classifyRoute } from '@/lib/auth/routes'

process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:9'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return routeFiles(p)
    return /^route\.tsx?$/.test(name) ? [p] : []
  })
}

const GUARDS = /require(PlatformAdmin|PlatformAdminRead|Workspace|User)Api\(/

test('every API handler is either explicitly public or guarded in-handler', () => {
  const failures: string[] = []
  for (const file of routeFiles('app/api')) {
    const src = readFileSync(file, 'utf8')
    const urlPath = '/' + file.replace(/^app\//, '').replace(/\/route\.tsx?$/, '').replace(/\[([^\]]+)\]/g, 'x')
    const handlers = [...src.matchAll(/^export (?:async )?function (GET|POST|PUT|PATCH|DELETE)\s*\(/gm)]
    for (const h of handlers) {
      const method = h[1]
      if (classifyRoute(urlPath, method) === 'public') continue
      // Body of this handler = text until the next top-level export.
      const start = h.index!
      const next = src.slice(start + 1).search(/^export /m)
      const body = next === -1 ? src.slice(start) : src.slice(start, start + 1 + next)
      if (!GUARDS.test(body)) failures.push(`${method} ${urlPath} (${file})`)
    }
  }
  assert.deepEqual(failures, [], `unguarded handlers:\n${failures.join('\n')}`)
})

test('privileged agent/ops actions reject unauthenticated callers inside the handler', async () => {
  const cases: Array<[string, string, string]> = [
    ['@/app/api/todos/route', 'POST', '/api/todos'],
    ['@/app/api/todos/route', 'PATCH', '/api/todos'],
    ['@/app/api/todos/route', 'DELETE', '/api/todos?id=00000000-0000-0000-0000-000000000000'],
    ['@/app/api/agents/control/route', 'POST', '/api/agents/control'],
    ['@/app/api/panic/route', 'POST', '/api/panic'],
    ['@/app/api/git/revert/route', 'POST', '/api/git/revert'],
    ['@/app/api/god-chat/route', 'POST', '/api/god-chat'],
    ['@/app/api/newsletter/send/route', 'POST', '/api/newsletter/send'],
    ['@/app/api/github/issues/sync/route', 'POST', '/api/github/issues/sync'],
  ]
  for (const [mod, method, path] of cases) {
    const handlers = await import(mod) as Record<string, (r: NextRequest) => Promise<Response>>
    const body = method === 'DELETE' ? undefined
      : JSON.stringify(path === '/api/todos' && method === 'PATCH'
        ? { id: '00000000-0000-0000-0000-000000000000', status: 'pending' }
        : { title: 'x', action: 'stop', name: 'god' })
    const res = await handlers[method](new NextRequest(new URL(path, 'http://localhost'), {
      method, body, headers: { 'content-type': 'application/json' },
    }))
    assert.equal(res.status, 401, `${method} ${path} must be 401 without a session`)
  }
})

test('webhooks fail closed when their secret is not configured', async () => {
  delete process.env.GITHUB_WEBHOOK_SECRET
  delete process.env.GENERIC_WEBHOOK_TOKEN
  const { POST } = await import('@/app/api/webhooks/[source]/route')
  const call = (source: string, headers: Record<string, string> = {}) =>
    POST(new NextRequest(new URL(`/api/webhooks/${source}?token=anything`, 'http://localhost'), {
      method: 'POST', body: '{"event":"x","title":"inject"}', headers,
    }), { params: Promise.resolve({ source }) })
  assert.equal((await call('github', { 'x-hub-signature-256': 'sha256=00' })).status, 401)
  assert.equal((await call('generic', { 'x-webhook-token': '' })).status, 401)
  assert.equal((await call('stripe')).status, 404, 'unverified sources are disabled')
  assert.equal((await call('shopify')).status, 404)
})
