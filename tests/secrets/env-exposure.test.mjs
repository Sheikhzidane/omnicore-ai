// scripts/check-env-exposure.mjs must fail on a real leak and pass on help text.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const SCRIPT = resolve('scripts/check-env-exposure.mjs')

function run(bundleSource, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'exposure-'))
  mkdirSync(join(dir, '.next', 'static', 'chunks'), { recursive: true })
  writeFileSync(join(dir, '.next', 'static', 'chunks', 'a.js'), bundleSource)
  return spawnSync(process.execPath, [SCRIPT, '--require-build'], { cwd: dir, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' })
}

test('passes when a secret name only appears in help text', () => {
  assert.equal(run('"Set RESEND_API_KEY in .env.local"').status, 0)
})

test('fails when client code reads a server secret', () => {
  const r = run('const k = process.env.ANTHROPIC_API_KEY')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /ANTHROPIC_API_KEY/)
})

test('fails when a secret VALUE is present in the bundle', () => {
  const r = run('const x = "service-role-abc123456"', { SUPABASE_SERVICE_ROLE_KEY: 'service-role-abc123456' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /VALUE of SUPABASE_SERVICE_ROLE_KEY/)
})

test('fails when source exposes a secret-like NEXT_PUBLIC_ variable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'exposure-src-'))
  // Assembled at runtime so this fixture doesn't trip the repo-wide scan.
  const leakedName = ['NEXT', 'PUBLIC', 'STRIPE', 'SECRET', 'KEY'].join('_')
  writeFileSync(join(dir, 'leak.ts'), `export const k = process.env.${leakedName}`)
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: dir, env: { PATH: process.env.PATH }, encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, new RegExp(leakedName))
})
