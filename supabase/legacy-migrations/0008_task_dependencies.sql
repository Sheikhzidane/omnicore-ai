-- ============================================================
-- Task Dependency Conflict Detection System
-- ============================================================

-- ============================================================
-- 1. Create task_dependencies table
-- Stores the dependency relationships between tasks
-- ============================================================
create table if not exists public.task_dependencies (
  id                    uuid primary key default gen_random_uuid(),
  task_id              uuid not null references public.todos(id) on delete cascade,
  depends_on_task_id   uuid not null references public.todos(id) on delete cascade,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  
  -- Ensure a task cannot depend on itself
  constraint no_self_dependency 
    check (task_id != depends_on_task_id),
  
  -- Ensure unique dependency relationships (prevent duplicates)
  unique(task_id, depends_on_task_id)
);

-- Auto-update updated_at
create trigger task_dependencies_updated_at
  before update on public.task_dependencies
  for each row execute procedure public.handle_updated_at();

-- Create indexes for fast lookups
create index if not exists idx_task_dependencies_task_id 
  on public.task_dependencies(task_id);
  
create index if not exists idx_task_dependencies_depends_on 
  on public.task_dependencies(depends_on_task_id);

-- Enable RLS
alter table public.task_dependencies enable row level security;

create policy "anon_select" on public.task_dependencies
  for select to anon using (true);

create policy "anon_insert" on public.task_dependencies
  for insert to anon with check (true);

create policy "anon_update" on public.task_dependencies
  for update to anon using (true) with check (true);

create policy "anon_delete" on public.task_dependencies
  for delete to anon using (true);

-- Add to realtime publication
alter publication supabase_realtime add table public.task_dependencies;

-- ============================================================
-- 2. Recursive CTE Function: Detect Circular Dependencies
-- Returns all tasks that task_id depends on (directly or indirectly)
-- ============================================================
create or replace function public.get_all_dependencies(p_task_id uuid)
returns table (
  dependency_id uuid,
  depth integer
) as $$
with recursive dependency_tree as (
  -- Base case: direct dependencies
  select 
    td.depends_on_task_id as dependency_id,
    1 as depth
  from public.task_dependencies td
  where td.task_id = p_task_id
  
  union all
  
  -- Recursive case: transitive dependencies
  select 
    td.depends_on_task_id,
    dt.depth + 1
  from dependency_tree dt
  join public.task_dependencies td 
    on td.task_id = dt.dependency_id
  where dt.depth < 100  -- Prevent infinite recursion; 100 level max depth
)
select distinct dependency_id, min(depth) as depth
from dependency_tree
group by dependency_id;
$$ language sql stable;

-- ============================================================
-- 3. Function: Check if adding a dependency creates a cycle
-- Returns TRUE if adding the dependency would create a circular dependency
-- ============================================================
create or replace function public.check_dependency_conflict(
  p_task_id uuid,
  p_depends_on_task_id uuid
)
returns jsonb as $$
declare
  v_has_cycle boolean;
  v_cycle_path text[];
  v_all_dependents record;
begin
  -- If task_id == depends_on_task_id, it's a self-reference
  if p_task_id = p_depends_on_task_id then
    return jsonb_build_object(
      'has_conflict', true,
      'conflict_type', 'self_reference',
      'message', 'A task cannot depend on itself',
      'conflicting_tasks', jsonb_build_array()
    );
  end if;

  -- Check if p_depends_on_task_id already depends on p_task_id
  -- If it does, adding p_task_id -> p_depends_on_task_id would create a cycle
  v_has_cycle := exists(
    select 1 from public.get_all_dependencies(p_depends_on_task_id) t
    where t.dependency_id = p_task_id
  );

  if v_has_cycle then
    -- Find the cycle path
    with cycle_analysis as (
      select 
        p_task_id::text as path,
        1 as depth
      union all
      select
        cycle_analysis.path || ' -> ' || td.depends_on_task_id::text,
        cycle_analysis.depth + 1
      from cycle_analysis
      join public.task_dependencies td 
        on td.task_id = (cycle_analysis.path::uuid[] || p_depends_on_task_id::uuid)[array_length(cycle_analysis.path::uuid[] || p_depends_on_task_id::uuid, 1)]
      where cycle_analysis.depth < 100
    )
    select path into v_cycle_path from cycle_analysis order by depth desc limit 1;

    return jsonb_build_object(
      'has_conflict', true,
      'conflict_type', 'circular_dependency',
      'message', 'Adding this dependency would create a circular dependency chain',
      'cycle_path', coalesce(array_to_json(v_cycle_path), jsonb_build_array()),
      'affected_task_id', p_depends_on_task_id,
      'would_cause_task_id', p_task_id
    );
  end if;

  -- No conflict detected
  return jsonb_build_object(
    'has_conflict', false,
    'conflict_type', null,
    'message', 'Dependency is valid and can be added',
    'conflicting_tasks', jsonb_build_array()
  );
end;
$$ language plpgsql stable;

-- ============================================================
-- 4. Function: Get full dependency tree for a task
-- Returns all ancestors and descendants with relationship info
-- ============================================================
create or replace function public.get_dependency_tree(p_task_id uuid)
returns table (
  task_id uuid,
  depends_on_id uuid,
  task_title text,
  depends_on_title text,
  task_status text,
  depends_on_status text,
  depth integer,
  is_blocker boolean,
  chain_length integer
) as $$
with recursive all_dependencies as (
  -- All tasks that p_task_id depends on (ancestors)
  select 
    p_task_id as root_task,
    td.depends_on_task_id as dependency_id,
    1 as depth,
    'ancestor' as rel_type
  from public.task_dependencies td
  where td.task_id = p_task_id
  
  union all
  
  select 
    ad.root_task,
    td.depends_on_task_id,
    ad.depth + 1,
    'ancestor'
  from all_dependencies ad
  join public.task_dependencies td 
    on td.task_id = ad.dependency_id
  where ad.depth < 100
),
all_dependents as (
  -- All tasks that depend on p_task_id (descendants)
  select 
    td.task_id as dependent_id,
    p_task_id as root_task,
    1 as depth,
    'descendant' as rel_type
  from public.task_dependencies td
  where td.depends_on_task_id = p_task_id
  
  union all
  
  select 
    td.task_id,
    ad.root_task,
    ad.depth + 1,
    'descendant'
  from all_dependents ad
  join public.task_dependencies td 
    on td.depends_on_task_id = ad.dependent_id
  where ad.depth < 100
)
select 
  coalesce(t1.id, t3.id) as task_id,
  coalesce(t2.id, t3.id) as depends_on_id,
  coalesce(t1.title, t3.title) as task_title,
  coalesce(t2.title, t3.title) as depends_on_title,
  coalesce(t1.status, 'unknown') as task_status,
  coalesce(t2.status, 'unknown') as depends_on_status,
  coalesce(ad.depth, all_dep.depth) as depth,
  (t2.status = 'failed' or t2.status = 'blocked') as is_blocker,
  coalesce(ad.depth, all_dep.depth) as chain_length
from all_dependencies all_dep
left join public.todos t1 on t1.id = p_task_id
left join public.todos t2 on t2.id = all_dep.dependency_id
full outer join all_dependents ad on true
left join public.todos t3 on t3.id = ad.dependent_id
where all_dep.root_task = p_task_id or ad.root_task = p_task_id;
$$ language sql stable;

-- ============================================================
-- 5. Function: Get all tasks with unmet dependencies
-- Returns tasks that are blocked by failed/incomplete dependencies
-- ============================================================
create or replace function public.get_blocked_tasks()
returns table (
  blocked_task_id uuid,
  blocked_task_title text,
  blocked_task_status text,
  blocker_task_id uuid,
  blocker_task_title text,
  blocker_task_status text,
  is_critical_block boolean,
  dependency_chain_length integer
) as $$
select 
  t1.id as blocked_task_id,
  t1.title as blocked_task_title,
  t1.status as blocked_task_status,
  t2.id as blocker_task_id,
  t2.title as blocker_task_title,
  t2.status as blocker_task_status,
  (t2.status in ('failed', 'blocked') or t1.status = 'blocked') as is_critical_block,
  ad.depth as dependency_chain_length
from public.task_dependencies td
join public.todos t1 on t1.id = td.task_id
join public.todos t2 on t2.id = td.depends_on_task_id
left join public.get_all_dependencies(td.task_id) ad on ad.dependency_id = td.depends_on_task_id
where t2.status in ('pending', 'in_progress', 'failed', 'blocked')
  or t1.status = 'blocked'
order by is_critical_block desc, ad.depth desc;
$$ language sql stable;

-- ============================================================
-- 6. Function: Validate dependency before insertion
-- Trigger function to run on INSERT/UPDATE
-- ============================================================
create or replace function public.validate_task_dependency()
returns trigger as $$
declare
  v_conflict jsonb;
begin
  -- Check for conflicts
  v_conflict := public.check_dependency_conflict(new.task_id, new.depends_on_task_id);
  
  if (v_conflict ->> 'has_conflict')::boolean then
    raise exception 'Dependency conflict: % (Type: %)',
      v_conflict ->> 'message',
      v_conflict ->> 'conflict_type';
  end if;
  
  return new;
end;
$$ language plpgsql;

-- Attach the trigger
create trigger validate_dependency_before_insert
  before insert on public.task_dependencies
  for each row execute procedure public.validate_task_dependency();
