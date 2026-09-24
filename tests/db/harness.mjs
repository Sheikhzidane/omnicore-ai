// Disposable-database harness for migration + RLS tests.
//
// Requires TEST_DATABASE_URL: a connection string for a THROWAWAY Postgres
// server where the test may create and drop databases (CI uses a postgres
// service container; locally any scratch cluster works). Each run creates a
// fresh database, applies supabase/tests/bootstrap.sql (Supabase roles + auth
// stubs) and every file in supabase/migrations/ in order, then drops it.
//
// NEVER point TEST_DATABASE_URL at a real Supabase project.

import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations')

export function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR).filter(f => /^\d{14}_[a-z0-9_]+\.sql$/.test(f)).sort()
}

export function databaseUrl() {
  const url = process.env.TEST_DATABASE_URL
  if (!url) return null
  if (/supabase\.co|pooler\.supabase/.test(url)) {
    throw new Error('TEST_DATABASE_URL points at a Supabase host. Use a disposable local/CI Postgres only.')
  }
  return url
}

function withDatabase(url, db) {
  const u = new URL(url)
  u.pathname = `/${db}`
  return u.toString()
}

/** Creates a fresh migrated database. Returns { client, drop }. */
export async function createMigratedDatabase() {
  const url = databaseUrl()
  const name = `omnicore_test_${process.pid}_${Date.now()}`
  const admin = new pg.Client({ connectionString: url })
  await admin.connect()
  await admin.query(`create database ${name}`)
  await admin.end()

  const client = new pg.Client({ connectionString: withDatabase(url, name) })
  await client.connect()
  await client.query('set client_min_messages = warning')
  await client.query(readFileSync(join(ROOT, 'supabase', 'tests', 'bootstrap.sql'), 'utf8'))
  for (const f of migrationFiles()) {
    try {
      await client.query(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
    } catch (e) {
      throw new Error(`Migration ${f} failed: ${e.message}`)
    }
  }

  return {
    client,
    async drop() {
      await client.end()
      const a = new pg.Client({ connectionString: url })
      await a.connect()
      await a.query(`drop database if exists ${name} with (force)`)
      await a.end()
    },
  }
}

/**
 * Runs `fn` inside a transaction as the given actor, then rolls back.
 * actor: 'anon' | 'service_role' | { userId } (authenticated user)
 */
export async function as(client, actor, fn) {
  await client.query('begin')
  client.__inTx = true
  try {
    if (actor === 'anon' || actor === 'service_role') {
      await client.query(`set local role ${actor}`)
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: actor })])
    } else {
      await client.query('set local role authenticated')
      await client.query(`select set_config('request.jwt.claims', $1, true)`,
        [JSON.stringify({ sub: actor.userId, role: 'authenticated' })])
    }
    return await fn(client)
  } finally {
    client.__inTx = false
    await client.query('rollback')
  }
}

/**
 * Runs `sql` expecting Postgres to reject it; returns the error message.
 * Wrapped in a savepoint so later statements in the same transaction still run.
 */
export async function expectError(client, sql, params = []) {
  if (!client.__inTx) {
    // Outside a transaction a failed statement doesn't poison anything.
    try { await client.query(sql, params) } catch (e) { return e.message }
    throw new Error(`expected the statement to be rejected, but it succeeded: ${sql}`)
  }
  await client.query('savepoint expect_error')
  try {
    await client.query(sql, params)
  } catch (e) {
    await client.query('rollback to savepoint expect_error')
    return e.message
  }
  await client.query('release savepoint expect_error')
  throw new Error(`expected the statement to be rejected, but it succeeded: ${sql}`)
}
