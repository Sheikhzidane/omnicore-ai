// Migration + RLS tests against a disposable Postgres (see harness.mjs).
// Run: TEST_DATABASE_URL=postgres://... npm run test:db
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createMigratedDatabase, databaseUrl, as, expectError } from './harness.mjs'

const skip = databaseUrl() ? false : 'TEST_DATABASE_URL not set — database tests skipped (CI always sets it)'

let db, c
const A = { userId: '00000000-0000-0000-0000-00000000000a' }
const B = { userId: '00000000-0000-0000-0000-00000000000b' }
const OPS = { userId: '00000000-0000-0000-0000-0000000000ff' }
let wsA, wsB, charA, charB

before(async () => {
  if (skip) return
  db = await createMigratedDatabase()
  c = db.client
  // Creating auth users fires the handle_new_user trigger → personal workspace.
  for (const [u, email] of [[A, 'a@example.com'], [B, 'b@example.com'], [OPS, 'ops@example.com']]) {
    await c.query('insert into auth.users (id, email) values ($1, $2)', [u.userId, email])
  }
  await c.query('insert into private.platform_admins (user_id) values ($1)', [OPS.userId])
  wsA = (await c.query('select id from public.workspaces where owner_id = $1', [A.userId])).rows[0].id
  wsB = (await c.query('select id from public.workspaces where owner_id = $1', [B.userId])).rows[0].id
  charA = (await c.query(`insert into public.characters (workspace_id, name, slug) values ($1, 'Nova', 'nova') returning id`, [wsA])).rows[0].id
  charB = (await c.query(`insert into public.characters (workspace_id, name, slug) values ($1, 'Orion', 'orion') returning id`, [wsB])).rows[0].id
  await c.query(`insert into public.agents (workspace_id, character_id, role, name) values ($1, $2, 'copywriter', 'A copy')`, [wsA, charA])
  await c.query(`insert into public.agents (workspace_id, character_id, role, name) values ($1, $2, 'copywriter', 'B copy')`, [wsB, charB])
  await c.query(`insert into public.audit_log (workspace_id, actor_type, actor_id, action) values ($1, 'user', $2, 'test.a')`, [wsA, A.userId])
  await c.query(`insert into public.audit_log (workspace_id, actor_type, actor_id, action) values ($1, 'user', $2, 'test.b')`, [wsB, B.userId])
  await c.query(`insert into public.todos (title) values ('legacy ops task')`)
})

after(async () => { if (db) await db.drop() })

test('every public table has RLS enabled', { skip }, async () => {
  const { rows } = await c.query(`
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`)
  assert.deepEqual(rows, [], `tables without RLS: ${rows.map(r => r.relname).join(', ')}`)
})

test('no policy grants anything to anon', { skip }, async () => {
  const { rows } = await c.query(`select tablename, policyname from pg_policies where 'anon' = any(roles) or 'public' = any(roles)`)
  assert.deepEqual(rows, [])
})

test('anon has no table privileges in public', { skip }, async () => {
  const { rows } = await c.query(`
    select table_name, privilege_type from information_schema.role_table_grants
    where grantee = 'anon' and table_schema = 'public'`)
  assert.deepEqual(rows, [])
})

test('anon cannot read or write anything', { skip }, async () => {
  for (const t of ['workspaces', 'characters', 'agents', 'agent_tasks', 'audit_log', 'todos', 'subscribers']) {
    await as(c, 'anon', async () => {
      const msg = await expectError(c, `select 1 from public.${t} limit 1`)
      assert.match(msg, /permission denied/)
    })
  }
  await as(c, 'anon', async () => {
    assert.match(await expectError(c, `insert into public.todos (title) values ('x')`), /permission denied/)
    assert.match(await expectError(c, `insert into public.subscribers (email) values ('x@y.z')`), /permission denied/)
  })
})

test('the private schema is not reachable by anon', { skip }, async () => {
  await as(c, 'anon', async () => {
    assert.match(await expectError(c, 'select * from private.platform_admins'), /permission denied/)
  })
})

test('new users get exactly one workspace where they are owner', { skip }, async () => {
  const { rows } = await c.query(`select role from public.workspace_members where user_id = $1`, [A.userId])
  assert.deepEqual(rows, [{ role: 'owner' }])
})

test('workspace isolation: users see only their own workspace data', { skip }, async () => {
  await as(c, A, async () => {
    const ws = await c.query('select id from public.workspaces')
    assert.deepEqual(ws.rows.map(r => r.id), [wsA])
    for (const t of ['characters', 'agents', 'audit_log', 'workspace_members']) {
      const { rows } = await c.query(`select workspace_id from public.${t}`)
      assert.ok(rows.length > 0, `${t}: expected own rows`)
      assert.ok(rows.every(r => r.workspace_id === wsA), `${t}: leaked another workspace`)
    }
    const other = await c.query('select * from public.characters where id = $1', [charB])
    assert.equal(other.rowCount, 0)
  })
})

test('clients cannot write safety or agent tables directly (server-only writes)', { skip }, async () => {
  await as(c, A, async () => {
    const stmts = [
      [`insert into public.characters (workspace_id, name, slug) values ($1, 'X', 'x')`, [wsA]],
      [`update public.characters set approval_mode = 'auto_low_risk' where id = $1`, [charA]],
      [`update public.agents set status = 'active' where workspace_id = $1`, [wsA]],
      [`insert into public.agent_tasks (workspace_id, character_id, agent_id, type, title) select workspace_id, character_id, id, 'x', 'x' from public.agents limit 1`, []],
      [`insert into public.audit_log (workspace_id, actor_type, action) values ($1, 'user', 'forged')`, [wsA]],
      [`delete from public.audit_log`, []],
    ]
    for (const [sql, params] of stmts) {
      assert.match(await expectError(c, sql, params), /permission denied/, sql)
    }
  })
})

test('members cannot join other workspaces or grant themselves ownership', { skip }, async () => {
  await as(c, A, async () => {
    // Insert into someone else's workspace: RLS violation.
    assert.match(await expectError(c, 
      `insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'viewer')`, [wsB, A.userId]),
      /row-level security/)
    // Owner may not mint another owner from the client.
    assert.match(await expectError(c, 
      `insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')`, [wsA, B.userId]),
      /row-level security/)
    // Cannot demote/modify the owner row (including their own).
    const upd = await c.query(`update public.workspace_members set role = 'viewer' where workspace_id = $1 and user_id = $2`, [wsA, A.userId])
    assert.equal(upd.rowCount, 0)
  })
})

test('a user cannot forge platform-admin status', { skip }, async () => {
  await as(c, A, async () => {
    assert.match(await expectError(c, 'insert into private.platform_admins (user_id) values ($1)', [A.userId]), /permission denied/)
    const { rows } = await c.query('select public.current_user_is_platform_admin() as ok')
    assert.equal(rows[0].ok, false)
  })
})

test('only the service role can sync platform-admin status', { skip }, async () => {
  await as(c, A, async () => {
    assert.match(await expectError(c, 'select public.sync_platform_admin($1, true)', [A.userId]), /permission denied/)
  })
  await as(c, 'service_role', async () => {
    await c.query('select public.sync_platform_admin($1, true)', [B.userId])
    // Same transaction: B now resolves as a platform admin.
    await c.query('set local role authenticated')
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: B.userId, role: 'authenticated' })])
    assert.equal((await c.query('select public.current_user_is_platform_admin() as ok')).rows[0].ok, true)
  })
})

test('legacy ops tables: platform admins only', { skip }, async () => {
  await as(c, A, async () => {
    assert.equal((await c.query('select * from public.todos')).rowCount, 0)
    assert.match(await expectError(c, `insert into public.todos (title) values ('inject')`), /permission denied/)
  })
  await as(c, OPS, async () => {
    assert.equal((await c.query('select * from public.todos')).rowCount, 1)
    // Even admins cannot approve/modify tasks from the client: writes go
    // through the audited /api/todos route.
    assert.match(await expectError(c, `update public.todos set status = 'pending'`), /permission denied/)
    assert.equal((await c.query('select public.current_user_is_platform_admin() as ok')).rows[0].ok, true)
  })
})

test('new legacy ops tasks default to proposed (require human approval)', { skip }, async () => {
  const { rows } = await c.query(`select status from public.todos limit 1`)
  assert.equal(rows[0].status, 'proposed')
})

test('arbitrary-SQL functions from the inherited agents do not exist', { skip }, async () => {
  const { rows } = await c.query(`select proname from pg_proc where proname in ('agent_exec_sql','agent_exec_ddl','execute_sql')`)
  assert.deepEqual(rows, [])
})

test('composite FKs block cross-workspace references (even for the service role)', { skip }, async () => {
  await as(c, 'service_role', async () => {
    const msg = await expectError(c, 
      `insert into public.agents (workspace_id, character_id, role, name) values ($1, $2, 'growth_analyst', 'cross')`, [wsA, charB])
    assert.match(msg, /foreign key/)
  })
})

test('safety constraints are enforced by the database', { skip }, async () => {
  await as(c, 'service_role', async () => {
    const bad = [
      [`update public.characters set ai_disclosure_mode = 'none' where id = $1`, [charA]],
      [`update public.characters set age_restricted = true, min_audience_age = 16 where id = $1`, [charA]],
      [`update public.characters set depicts_real_person = true where id = $1`, [charA]],
      [`insert into public.publishing_policies (workspace_id, platform, sponsored_disclosure_required) values ($1, 'x', false)`, [wsA]],
      [`insert into public.publishing_policies (workspace_id, platform, min_minutes_between_posts) values ($1, 'x', 1)`, [wsA]],
    ]
    for (const [sql, params] of bad) {
      await c.query('savepoint s')
      assert.match(await expectError(c, sql, params), /check constraint|violates/, sql)
      await c.query('rollback to savepoint s')
    }
    const { rows } = await c.query('select approval_mode, ai_disclosure_mode from public.characters where id = $1', [charA])
    assert.deepEqual(rows[0], { approval_mode: 'human_required', ai_disclosure_mode: 'always' })
  })
})

test('agents start disabled and tasks start proposed', { skip }, async () => {
  const { rows } = await c.query(`select status, autonomy from public.agents where workspace_id = $1`, [wsA])
  assert.deepEqual(rows[0], { status: 'disabled', autonomy: 'approval_required' })
})

test('audit_log is append-only even for the service role', { skip }, async () => {
  await as(c, 'service_role', async () => {
    assert.match(await expectError(c, `update public.audit_log set action = 'rewritten'`), /append-only/)
  })
  await as(c, 'service_role', async () => {
    assert.match(await expectError(c, `delete from public.audit_log`), /append-only/)
  })
})

test('claim_agent_tasks: service role only, skips disabled agents and unapproved tasks', { skip }, async () => {
  await as(c, A, async () => {
    assert.match(await expectError(c, 'select * from public.claim_agent_tasks(5)'), /permission denied/)
  })
  await as(c, 'service_role', async () => {
    const agent = (await c.query(`select id, character_id from public.agents where workspace_id = $1`, [wsA])).rows[0]
    // Unapproved task on a disabled agent.
    await c.query(`insert into public.agent_tasks (workspace_id, character_id, agent_id, type, title, status, requires_approval)
                   values ($1, $2, $3, 'draft_caption', 't1', 'pending', false)`, [wsA, agent.character_id, agent.id])
    assert.equal((await c.query('select * from public.claim_agent_tasks(5)')).rowCount, 0, 'disabled agent must not run')

    await c.query(`update public.agents set status = 'active' where id = $1`, [agent.id])
    await c.query(`insert into public.agent_tasks (workspace_id, character_id, agent_id, type, title)
                   values ($1, $2, $3, 'draft_caption', 'awaiting human')`, [wsA, agent.character_id, agent.id])
    const claimed = await c.query('select title, status from public.claim_agent_tasks(5)')
    assert.deepEqual(claimed.rows, [{ title: 't1', status: 'running' }], 'only the approved/pending task is claimed')

    // A task requiring approval cannot be marked pending without approval.
    assert.match(await expectError(c, 
      `insert into public.agent_tasks (workspace_id, character_id, agent_id, type, title, status)
       values ($1, $2, $3, 'draft_caption', 'sneaky', 'pending')`, [wsA, agent.character_id, agent.id]),
      /agent_tasks_approval_recorded/)
  })
})
