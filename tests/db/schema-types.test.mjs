// types/database.ts must match the migrated schema exactly (column names per
// table), so hand-maintained types can never drift from the migrations.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createMigratedDatabase, databaseUrl } from './harness.mjs'

const skip = databaseUrl() ? false : 'TEST_DATABASE_URL not set — database tests skipped (CI always sets it)'
let db

before(async () => { if (!skip) db = await createMigratedDatabase() })
after(async () => { if (db) await db.drop() })

function typedTables() {
  const src = readFileSync('types/database.ts', 'utf8')
  const block = src.slice(src.indexOf('Tables: {'), src.indexOf('Views:'))
  const tables = [...block.matchAll(/^\s+(\w+):\s+Table<(\w+),/gm)].map(m => ({ table: m[1], rowType: m[2] }))
  return tables.map(({ table, rowType }) => {
    const start = src.indexOf(`export type ${rowType} =`)
    assert.ok(start >= 0, `row type ${rowType} not found`)
    const body = src.slice(src.indexOf('{', start), src.indexOf('\n}', start))
    const fields = [...body.matchAll(/^\s+(\w+):/gm)].map(m => m[1])
    if (src.slice(start, src.indexOf('{', start)).includes('Timestamps')) fields.push('created_at', 'updated_at')
    return { table, fields: [...new Set(fields)].sort() }
  })
}

test('every typed table exists with exactly the typed columns', { skip }, async () => {
  const tables = typedTables()
  assert.ok(tables.length >= 14, `expected >= 14 typed tables, got ${tables.length}`)
  for (const { table, fields } of tables) {
    const { rows } = await db.client.query(
      `select column_name from information_schema.columns where table_schema = 'public' and table_name = $1 order by column_name`, [table])
    assert.deepEqual(fields, rows.map(r => r.column_name), `columns differ for ${table}`)
  }
})
