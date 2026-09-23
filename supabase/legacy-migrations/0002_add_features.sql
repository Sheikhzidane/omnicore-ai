-- ============================================================
-- Add fun feature columns to todos
-- Run this in Supabase SQL Editor
-- ============================================================

alter table public.todos
  add column if not exists is_boss    boolean      not null default false,
  add column if not exists deadline   timestamptz,
  add column if not exists comments   jsonb        not null default '[]'::jsonb,
  add column if not exists retry_count integer     not null default 0;
