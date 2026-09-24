// Product schema tests (character identity, storage, social, approvals,
// content/publishing, analytics/engagement, monetisation) against a disposable
// Postgres. Run: TEST_DATABASE_URL=postgres://… npm run test:db
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createMigratedDatabase, databaseUrl, as, expectError } from './harness.mjs'

const skip = databaseUrl() ? false : 'TEST_DATABASE_URL not set — database tests skipped (CI always sets it)'
const A = { userId: '00000000-0000-0000-0000-0000000000a1' }
const B = { userId: '00000000-0000-0000-0000-0000000000b1' }
let db, c, wsA, wsB, charA, charB, acctA, acctB, agentA

const q = async (sql, params) => (await c.query(sql, params)).rows
const one = async (sql, params) => (await q(sql, params))[0]
const CIPHER = 'v1.aXY.dGFn.Y2lwaGVy'

async function approval(ws, status = 'AWAITING_APPROVAL', extra = {}) {
  const row = await one(`insert into public.agent_approvals (workspace_id, action_type, entity_type, title, requested_by_type, requested_by_user, payload, expires_at, status)
                         values ($1, 'publish_content', 'content_item', 'Publish', 'user', $2, $3, $4, 'AWAITING_APPROVAL') returning *`,
    [ws, ws === wsA ? A.userId : B.userId, JSON.stringify(extra.payload ?? {}), extra.expires_at ?? null])
  if (status === 'APPROVED') {
    return one(`update public.agent_approvals set status = 'APPROVED', decided_by = $2 where id = $1 returning *`, [row.id, ws === wsA ? A.userId : B.userId])
  }
  return row
}

async function releasableItem(ws, charId) {
  const ap = await approval(ws, 'APPROVED')
  return one(`insert into public.content_items (workspace_id, character_id, platform, format, title, status, safety_status, disclosure_applied, approval_id)
              values ($1, $2, 'instagram', 'post', 'Post', 'approved', 'passed', true, $3) returning *`, [ws, charId, ap.id])
}

before(async () => {
  if (skip) return
  db = await createMigratedDatabase()
  c = db.client
  for (const [u, e] of [[A, 'a1@example.com'], [B, 'b1@example.com']]) await q('insert into auth.users (id, email) values ($1, $2)', [u.userId, e])
  wsA = (await one('select id from public.workspaces where owner_id = $1', [A.userId])).id
  wsB = (await one('select id from public.workspaces where owner_id = $1', [B.userId])).id
  charA = (await one(`insert into public.characters (workspace_id, name, slug, status) values ($1, 'Nova', 'nova', 'active') returning id`, [wsA])).id
  charB = (await one(`insert into public.characters (workspace_id, name, slug) values ($1, 'Orion', 'orion') returning id`, [wsB])).id
  acctA = (await one(`insert into public.social_accounts (workspace_id, character_id, platform, status, external_account_id, connected_at)
                      values ($1, $2, 'instagram', 'connected', 'ig-1', now()) returning id`, [wsA, charA])).id
  acctB = (await one(`insert into public.social_accounts (workspace_id, character_id, platform) values ($1, $2, 'instagram') returning id`, [wsB, charB])).id
  agentA = (await one(`insert into public.agents (workspace_id, character_id, role, name) values ($1, $2, 'copywriter', 'Copy') returning id`, [wsA, charA])).id
  for (const [ws, ch] of [[wsA, charA], [wsB, charB]]) {
    await q(`insert into public.character_profiles (workspace_id, character_id, display_name) values ($1, $2, 'Display')`, [ws, ch])
    await q(`insert into public.leads (workspace_id, brand_name) values ($1, 'Acme')`, [ws])
    await q(`insert into public.revenue (workspace_id, character_id, source_type, amount_cents, occurred_on) values ($1, $2, 'tips', 1000, current_date)`, [ws, ch])
    await q(`insert into public.expenses (workspace_id, character_id, category, amount_cents, occurred_on) values ($1, $2, 'software', 300, current_date)`, [ws, ch])
  }
})
after(async () => { if (db) await db.drop() })

test('every workspace table: RLS on, members read-only, clients cannot write', { skip }, async () => {
  const tables = (await q(`select table_name from information_schema.columns where table_schema = 'public' and column_name = 'workspace_id'
                           and table_name in (select tablename from pg_tables where schemaname = 'public')`)).map(r => r.table_name)
  assert.ok(tables.length >= 40, `expected >= 40 workspace tables, got ${tables.length}`)
  // workspace_members keeps owner-only write POLICIES (membership management),
  // covered by the escalation tests in rls.test.mjs. Everything else: no writes.
  const POLICY_WRITABLE = new Set(['workspace_members'])
  for (const t of tables.filter(t => !POLICY_WRITABLE.has(t))) {
    const rls = await one(`select relrowsecurity from pg_class where oid = $1::regclass`, [`public.${t}`])
    assert.equal(rls.relrowsecurity, true, `${t} RLS`)
    const priv = await q(`select privilege_type from information_schema.role_table_grants
                          where table_schema = 'public' and table_name = $1 and grantee = 'authenticated'
                            and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')`, [t])
    assert.deepEqual(priv, [], `${t}: authenticated must have no write privileges`)
  }
})

test('workspace isolation across new tables and the financials view', { skip }, async () => {
  await as(c, A, async () => {
    for (const t of ['character_profiles', 'social_accounts', 'leads', 'revenue', 'expenses']) {
      const rows = await q(`select workspace_id from public.${t}`)
      assert.ok(rows.length > 0 && rows.every(r => r.workspace_id === wsA), `${t} leaked`)
    }
    const fin = await q('select * from public.character_financials')
    assert.equal(fin.length, 1)
    assert.equal(fin[0].workspace_id, wsA)
    assert.equal(Number(fin[0].profit_cents), 700)
  })
  await as(c, 'anon', async () => {
    assert.match(await expectError(c, 'select * from public.character_financials'), /permission denied/)
  })
})

test('storage: private buckets with size and MIME limits', { skip }, async () => {
  const buckets = await q('select id, public, file_size_limit, allowed_mime_types from storage.buckets order by id')
  assert.deepEqual(buckets.map(b => b.id), ['campaign-assets', 'character-assets', 'generated-content', 'reference-images'])
  assert.ok(buckets.every(b => b.public === false && Number(b.file_size_limit) > 0 && b.allowed_mime_types.length > 0))
  assert.ok(!buckets.find(b => b.id === 'reference-images').allowed_mime_types.includes('video/mp4'))
})

test('storage: members read only their workspace folder; clients cannot write objects', { skip }, async () => {
  await q(`insert into storage.objects (bucket_id, name) values ('character-assets', $1), ('character-assets', $2), ('character-assets', 'not-a-uuid/x.png')`,
    [`${wsA}/${charA}/a.png`, `${wsB}/${charB}/b.png`])
  await as(c, A, async () => {
    const rows = await q(`select name from storage.objects where bucket_id = 'character-assets'`)
    assert.deepEqual(rows.map(r => r.name), [`${wsA}/${charA}/a.png`])
    assert.match(await expectError(c, `insert into storage.objects (bucket_id, name) values ('character-assets', $1)`, [`${wsA}/${charA}/evil.png`]), /row-level security/)
    const del = await c.query(`delete from storage.objects where name = $1`, [`${wsA}/${charA}/a.png`])
    assert.equal(del.rowCount, 0, 'no delete policy')
  })
})

test('assets: storage path must be under <workspace>/<character>/ and real-person likeness needs consent', { skip }, async () => {
  const base = `insert into public.character_assets (workspace_id, character_id, kind, storage_bucket, storage_path, file_name, mime_type, bytes, provenance, depicts_real_person, consent_evidence_path)
                values ($1, $2, 'reference_image', 'reference-images', $3, 'x.png', 'image/png', 10, 'owned', $4, $5)`
  assert.match(await expectError(c, base, [wsA, charA, `${wsB}/${charA}/x.png`, false, null]), /character_assets_path_owned/)
  assert.match(await expectError(c, base, [wsA, charA, `${wsA}/${charA}/../x.png`, false, null]), /character_assets_path_owned/)
  assert.match(await expectError(c, base, [wsA, charA, `${wsA}/${charA}/x.png`, true, null]), /consent/)
  await q(base, [wsA, charA, `${wsA}/${charA}/ok.png`, false, null])
})

test('memories: agent-proposed memories cannot become canon without human confirmation', { skip }, async () => {
  assert.match(await expectError(c, `insert into public.character_memories (workspace_id, character_id, kind, content, source, is_canon) values ($1, $2, 'fact', 'x', 'agent', true)`, [wsA, charA]),
    /canon_confirmed/)
  await q(`insert into public.character_memories (workspace_id, character_id, kind, content, source, is_canon, confirmed_by) values ($1, $2, 'fact', 'x', 'agent', true, $3)`, [wsA, charA, A.userId])
})

test('social credentials: ciphertext only, service-role functions only', { skip }, async () => {
  for (const fn of [`select public.store_social_credential($1, '${CIPHER}')`, 'select public.read_social_credential($1)']) {
    await as(c, A, async () => { assert.match(await expectError(c, fn, [acctA]), /permission denied/) })
  }
  await as(c, A, async () => {
    assert.match(await expectError(c, 'select * from private.social_credential_secrets'), /permission denied/)
  })
  await as(c, 'service_role', async () => {
    assert.match(await expectError(c, `select public.store_social_credential($1, 'raw-access-token')`, [acctA]), /check constraint/)
    await q(`select public.store_social_credential($1, '${CIPHER}')`, [acctA])
    assert.equal((await one('select public.read_social_credential($1) as v', [acctA])).v, CIPHER)
  })
  const cols = await q(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'social_credentials_metadata'`)
  assert.ok(!cols.some(r => /secret|cipher|access_token|refresh_token|^token$/.test(r.column_name)), 'metadata table must not hold secrets')
})

test('approvals: state machine enforced for everyone', { skip }, async () => {
  assert.match(await expectError(c, `insert into public.agent_approvals (workspace_id, action_type, entity_type, title, requested_by_type, requested_by_user, status)
                                     values ($1, 'publish_content', 'content_item', 't', 'user', $2, 'APPROVED')`, [wsA, A.userId]), /DRAFT or AWAITING_APPROVAL/)
  const ap = await approval(wsA)
  assert.match(await expectError(c, `update public.agent_approvals set status = 'APPROVED' where id = $1`, [ap.id]), /human decision/)
  assert.match(await expectError(c, `update public.agent_approvals set status = 'COMPLETED', decided_by = $2 where id = $1`, [ap.id, A.userId]), /invalid approval transition/)
  assert.match(await expectError(c, `update public.agent_approvals set payload = '{"x":1}' where id = $1`, [ap.id]), /payload cannot change/)
  await q(`update public.agent_approvals set status = 'APPROVED', decided_by = $2 where id = $1`, [ap.id, A.userId])
  await q(`update public.agent_approvals set status = 'EXECUTING' where id = $1`, [ap.id])
  const failed = await one(`update public.agent_approvals set status = 'FAILED', error = 'boom' where id = $1 returning *`, [ap.id])
  assert.ok(failed.completed_at)
  const retry = await one(`update public.agent_approvals set status = 'AWAITING_APPROVAL' where id = $1 returning *`, [ap.id])
  assert.equal(retry.decided_by, null, 'retry requires a fresh human decision')
  const expired = await approval(wsA, 'AWAITING_APPROVAL', { expires_at: new Date(Date.now() - 60_000).toISOString() })
  assert.match(await expectError(c, `update public.agent_approvals set status = 'APPROVED', decided_by = $2 where id = $1`, [expired.id, A.userId]), /expired/)
})

test('approvals: agent requests must name the agent; clients cannot decide', { skip }, async () => {
  assert.match(await expectError(c, `insert into public.agent_approvals (workspace_id, action_type, entity_type, title, requested_by_type)
                                     values ($1, 'brand_outreach', 'lead', 't', 'agent')`, [wsA]), /requester_consistent/)
  const ap = await approval(wsA)
  await as(c, A, async () => {
    assert.match(await expectError(c, `update public.agent_approvals set status = 'APPROVED', decided_by = $2 where id = $1`, [ap.id, A.userId]), /permission denied/)
  })
})

test('content: release gate requires passed safety, disclosure and approval; versions immutable', { skip }, async () => {
  const ap = await approval(wsA, 'APPROVED')
  const ins = `insert into public.content_items (workspace_id, character_id, platform, format, title, status, safety_status, disclosure_applied, approval_id)
               values ($1, $2, 'instagram', 'post', 't', 'approved', $3, $4, $5)`
  assert.match(await expectError(c, ins, [wsA, charA, 'flagged', true, ap.id]), /release_gate/)
  assert.match(await expectError(c, ins, [wsA, charA, 'passed', false, ap.id]), /release_gate/)
  assert.match(await expectError(c, ins, [wsA, charA, 'passed', true, null]), /release_gate/)
  const item = await one(ins + ' returning id', [wsA, charA, 'passed', true, ap.id])
  const v = await one(`insert into public.content_versions (workspace_id, content_item_id, version, caption, created_by_type) values ($1, $2, 1, 'hi', 'user') returning id`, [wsA, item.id])
  assert.match(await expectError(c, `update public.content_versions set caption = 'changed' where id = $1`, [v.id]), /immutable/)
  assert.match(await expectError(c, `insert into public.content_items (workspace_id, character_id, platform, format, title) values ($1, $2, 'instagram', 'post', 'x')`, [wsA, charB]), /foreign key/)
})

test('publishing: approval required, no duplicates, idempotent, SKIP LOCKED claim', { skip }, async () => {
  const item = await releasableItem(wsA, charA)
  const job = `insert into public.publishing_jobs (workspace_id, content_item_id, social_account_id, platform, scheduled_for, status, approval_id, idempotency_key)
               values ($1, $2, $3, 'instagram', now() - interval '1 minute', $4, $5, $6)`
  assert.match(await expectError(c, job, [wsA, item.id, acctA, 'queued', null, 'key-noauth-1']), /publishing_jobs_authorised/)
  const pending = await approval(wsA)
  assert.match(await expectError(c, job, [wsA, item.id, acctA, 'queued', pending.id, 'key-pending-1']), /requires an approved approval/)
  const ok = await approval(wsA, 'APPROVED')
  await q(job, [wsA, item.id, acctA, 'queued', ok.id, 'key-ok-00001'])
  assert.match(await expectError(c, job, [wsA, item.id, acctA, 'queued', ok.id, 'key-dup-00001']), /publishing_jobs_no_duplicates/)
  await as(c, 'service_role', async () => {
    const claimed = await q('select * from public.claim_publishing_jobs(10)')
    assert.equal(claimed.length, 1)
    assert.equal(claimed[0].status, 'running')
    assert.equal((await q('select * from public.claim_publishing_jobs(10)')).length, 0, 'a running job is never claimed twice')
  })
  await as(c, A, async () => {
    assert.match(await expectError(c, 'select * from public.claim_publishing_jobs(1)'), /permission denied/)
  })
})

test('publishing: failures back off and eventually fail; success is recorded once', { skip }, async () => {
  const item = await releasableItem(wsA, charA)
  const ok = await approval(wsA, 'APPROVED')
  await q(`update public.social_accounts set status = 'connected' where id = $1`, [acctA])
  const acct2 = (await one(`insert into public.characters (workspace_id, name, slug, status) values ($1, 'Vega', 'vega', 'active') returning id`, [wsA])).id
  const acctVega = (await one(`insert into public.social_accounts (workspace_id, character_id, platform, status, external_account_id, connected_at)
                               values ($1, $2, 'x', 'connected', 'x-1', now()) returning id`, [wsA, acct2])).id
  const jobRow = await one(`insert into public.publishing_jobs (workspace_id, content_item_id, social_account_id, platform, scheduled_for, status, approval_id, idempotency_key, max_attempts)
                            values ($1, $2, $3, 'x', now() - interval '1 minute', 'queued', $4, 'retry-key-0001', 2) returning id`, [wsA, item.id, acctVega, ok.id])
  await as(c, 'service_role', async () => {
    await q('select * from public.claim_publishing_jobs(10)')
    const afterFail = await one(`select * from public.complete_publishing_job($1, false, null, null, 'rate limited')`, [jobRow.id])
    assert.equal(afterFail.status, 'queued')
    assert.ok(new Date(afterFail.next_attempt_at) > new Date(), 'backoff scheduled in the future')
    await q(`update public.publishing_jobs set next_attempt_at = now() - interval '1 second' where id = $1`, [jobRow.id])
    await q('select * from public.claim_publishing_jobs(10)')
    const final = await one(`select * from public.complete_publishing_job($1, false, null, null, 'still failing')`, [jobRow.id])
    assert.equal(final.status, 'failed')
    assert.equal((await one('select status from public.content_items where id = $1', [item.id])).status, 'failed')
    assert.match(await expectError(c, `select * from public.complete_publishing_job($1, true, 'p1', 'https://x.com/p1')`, [jobRow.id]), /not running/)
  })
  const item2 = await releasableItem(wsA, charA)
  const ok2 = await approval(wsA, 'APPROVED')
  const job2 = await one(`insert into public.publishing_jobs (workspace_id, content_item_id, social_account_id, platform, scheduled_for, status, approval_id, idempotency_key)
                          values ($1, $2, $3, 'x', now() - interval '1 minute', 'queued', $4, 'success-key-01') returning id`, [wsA, item2.id, acctVega, ok2.id])
  await as(c, 'service_role', async () => {
    await q('select * from public.claim_publishing_jobs(10)')
    const done = await one(`select * from public.complete_publishing_job($1, true, 'p-2', 'https://x.com/p-2')`, [job2.id])
    assert.equal(done.status, 'succeeded')
    assert.equal((await one('select status from public.content_items where id = $1', [item2.id])).status, 'published')
  })
})

test('publishing: jobs for disconnected accounts are never claimed', { skip }, async () => {
  const itemB = await releasableItem(wsB, charB)
  const okB = await approval(wsB, 'APPROVED')
  await q(`insert into public.publishing_jobs (workspace_id, content_item_id, social_account_id, platform, scheduled_for, status, approval_id, idempotency_key)
           values ($1, $2, $3, 'instagram', now() - interval '1 minute', 'queued', $4, 'disconnected-1')`, [wsB, itemB.id, acctB, okB.id])
  await as(c, 'service_role', async () => {
    const claimed = await q('select * from public.claim_publishing_jobs(50)')
    assert.ok(!claimed.some(j => j.social_account_id === acctB))
  })
})

test('engagement: replies cannot be sent without approval and are marked AI-generated', { skip }, async () => {
  const item = await one(`insert into public.engagement_items (workspace_id, character_id, social_account_id, platform, kind, external_id, body, received_at)
                          values ($1, $2, $3, 'instagram', 'comment', 'c-1', 'love this', now()) returning id`, [wsA, charA, acctA])
  assert.match(await expectError(c, `insert into public.engagement_replies (workspace_id, engagement_item_id, body, status) values ($1, $2, 'thanks!', 'sent')`, [wsA, item.id]),
    /send_needs_approval/)
  const r = await one(`insert into public.engagement_replies (workspace_id, engagement_item_id, body) values ($1, $2, 'thanks!') returning is_ai_generated, status`, [wsA, item.id])
  assert.deepEqual(r, { is_ai_generated: true, status: 'suggested' })
})

test('monetisation: sponsorship disclosure cannot be disabled; deals require sponsored content', { skip }, async () => {
  assert.match(await expectError(c, `insert into public.brand_deals (workspace_id, character_id, title, disclosure_required) values ($1, $2, 'Deal', false)`, [wsA, charA]), /check constraint/)
  const deal = await one(`insert into public.brand_deals (workspace_id, character_id, title) values ($1, $2, 'Deal') returning id`, [wsA, charA])
  assert.match(await expectError(c, `insert into public.content_items (workspace_id, character_id, platform, format, title, brand_deal_id, is_sponsored) values ($1, $2, 'x', 'post', 't', $3, false)`, [wsA, charA, deal.id]),
    /deal_is_sponsored/)
  assert.match(await expectError(c, `insert into public.brand_contacts (workspace_id, brand_name, consent_basis) values ($1, 'X', 'scraped')`, [wsA]), /check constraint/)
})

test('webhook events are idempotent per provider event id', { skip }, async () => {
  await q(`insert into public.webhook_events (provider, event_id, signature_valid) values ('instagram', 'evt-1', true)`)
  await q(`insert into public.webhook_events (provider, event_id, signature_valid) values ('x', 'evt-1', true)`) // same id, other provider: fine
  assert.match(await expectError(c, `insert into public.webhook_events (provider, event_id, signature_valid) values ('instagram', 'evt-1', true)`), /duplicate key/)
})

test('publishing policies: safe defaults; auto-publish requires no human approval flag', { skip }, async () => {
  const p = await one(`insert into public.publishing_policies (workspace_id, platform) values ($1, 'tiktok') returning *`, [wsA])
  assert.equal(p.requires_human_approval, true)
  assert.equal(p.auto_publish_allowed, false)
  assert.equal(p.publishing_enabled, false)
  assert.match(await expectError(c, `update public.publishing_policies set auto_publish_allowed = true where id = $1`, [p.id]), /auto_needs_no_human/)
  assert.match(await expectError(c, `insert into public.publishing_policies (workspace_id, platform) values ($1, 'tiktok')`, [wsA]), /duplicate key/)
})

test('agent roster: exactly the 15 roles; agents cannot reference other workspaces', { skip }, async () => {
  assert.match(await expectError(c, `insert into public.agents (workspace_id, character_id, role, name) values ($1, $2, 'god', 'x')`, [wsA, charA]), /agents_role_check/)
  assert.match(await expectError(c, `insert into public.agents (workspace_id, character_id, role, name) values ($1, $2, 'safety', 'x')`, [wsA, charB]), /foreign key/)
  assert.ok(agentA)
})
