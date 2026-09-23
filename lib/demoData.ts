import type { Todo } from '@/types/todos'

/**
 * Canned dashboard data for first-time visitors who hit `/ops?demo=1`. Lets the
 * homepage look populated without a real Supabase connection — important
 * because otherwise the dashboard appears broken to anyone shared the URL.
 */
export const DEMO_TODOS: Todo[] = [
  {
    id: 'demo-1', title: 'Add dark-mode toggle to topbar', status: 'completed',
    priority: 'medium', assigned_agent: 'ui-specialist-a1c4',
    updated_at: new Date(Date.now() - 12 * 60_000).toISOString(),
    created_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    is_boss: false, deadline: null, retry_count: 0, parent_task_id: null,
    description: null,
    metadata: null,
    task_category: 'ui',
    comments: [
      { agent: 'god',            at: new Date(Date.now() - 2 * 3_600_000).toISOString(), text: 'Routing to ui-specialist; matches keyword "topbar"' },
      { agent: 'ui-specialist',  at: new Date(Date.now() - 30 * 60_000).toISOString(),    text: 'Built ThemeToggle.tsx with localStorage persistence + system-pref fallback. Verified: 0 TS errors.' },
      { agent: 'verifier',       at: new Date(Date.now() - 12 * 60_000).toISOString(),    text: '✓ Build passes. ✓ Files changed: 2. Marking complete.' },
    ],
  },
  {
    id: 'demo-2', title: 'Investigate cost spike on May 1', status: 'in_progress',
    priority: 'high', assigned_agent: 'analysis-specialist-7b2e',
    updated_at: new Date(Date.now() - 90_000).toISOString(),
    created_at: new Date(Date.now() - 25 * 60_000).toISOString(),
    is_boss: true, deadline: null, retry_count: 0, parent_task_id: null,
    description: null,
    metadata: null,
    task_category: 'analysis',
    comments: [
      { agent: 'god',                  at: new Date(Date.now() - 25 * 60_000).toISOString(), text: 'Daily spend hit $4.20 — investigation needed' },
      { agent: 'analysis-specialist',  at: new Date(Date.now() - 90_000).toISOString(),     text: 'Querying cost_log; correlating with task volume…' },
    ],
  },
  {
    id: 'demo-3', title: 'Migrate user_profile schema to v3', status: 'failed',
    priority: 'critical', assigned_agent: 'db-specialist-1f9d',
    updated_at: new Date(Date.now() - 4 * 3_600_000).toISOString(),
    created_at: new Date(Date.now() - 5 * 3_600_000).toISOString(),
    is_boss: false, deadline: null, retry_count: 2, parent_task_id: null,
    description: null,
    metadata: null,
    task_category: 'db',
    comments: [
      { agent: 'db-specialist', at: new Date(Date.now() - 4.5 * 3_600_000).toISOString(), text: 'Migration applied. Rolling forward indexes…' },
      { agent: 'db-specialist', at: new Date(Date.now() - 4 * 3_600_000).toISOString(),   text: 'ERROR: column "legacy_id" already dropped; conflicts with v2 trigger. Reverting.' },
    ],
  },
  {
    id: 'demo-4', title: 'Auto-publish weekly newsletter to Substack', status: 'pending',
    priority: 'medium', assigned_agent: null,
    updated_at: new Date(Date.now() - 20 * 60_000).toISOString(),
    created_at: new Date(Date.now() - 20 * 60_000).toISOString(),
    is_boss: false, deadline: null, retry_count: 0, parent_task_id: null,
    description: null,
    metadata: null,
    task_category: 'infra',
    comments: [],
  },
  {
    id: 'demo-5', title: 'Generate SEO topic: "Claude prompt caching guide"', status: 'completed',
    priority: 'low', assigned_agent: 'ui-specialist-3d7c',
    updated_at: new Date(Date.now() - 47 * 60_000).toISOString(),
    created_at: new Date(Date.now() - 67 * 60_000).toISOString(),
    is_boss: false, deadline: null, retry_count: 0, parent_task_id: null,
    description: null,
    metadata: null,
    task_category: 'ui',
    comments: [
      { agent: 'ui-specialist', at: new Date(Date.now() - 47 * 60_000).toISOString(), text: '✓ Created /topics/claude-prompt-caching-guide with AdSense + Amazon + Kit CTA. Submitted to IndexNow.' },
    ],
  },
  {
    id: 'demo-6', title: 'Refactor router.ts to support streaming responses', status: 'completed',
    priority: 'high', assigned_agent: 'infra-specialist-8e2a',
    updated_at: new Date(Date.now() - 8 * 3_600_000).toISOString(),
    created_at: new Date(Date.now() - 9 * 3_600_000).toISOString(),
    is_boss: false, deadline: null, retry_count: 1, parent_task_id: null,
    description: null,
    metadata: null,
    task_category: 'infra',
    comments: [
      { agent: 'infra-specialist', at: new Date(Date.now() - 9 * 3_600_000).toISOString(), text: 'Initial pass: ReadableStream wired up. Tests failing on backpressure.' },
      { agent: 'infra-specialist', at: new Date(Date.now() - 8 * 3_600_000).toISOString(), text: '✓ Fixed by adding manual flush hooks. All tests pass.' },
    ],
  },
  {
    id: 'demo-7', title: 'Add per-agent latency histogram to dashboard', status: 'completed',
    priority: 'medium', assigned_agent: 'ui-specialist-a1c4',
    updated_at: new Date(Date.now() - 18 * 3_600_000).toISOString(),
    created_at: new Date(Date.now() - 20 * 3_600_000).toISOString(),
    is_boss: false, deadline: null, retry_count: 0, parent_task_id: null,
    description: null,
    metadata: null,
    task_category: 'ui',
    comments: [
      { agent: 'ui-specialist', at: new Date(Date.now() - 18 * 3_600_000).toISOString(), text: '✓ Added LatencyDistribution.tsx with p50/p95/p99 markers' },
    ],
  },
]

export const IS_DEMO_QUERY_KEY = 'demo'
