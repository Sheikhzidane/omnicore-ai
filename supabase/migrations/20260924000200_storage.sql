-- ============================================================================
-- Supabase Storage: private buckets + object policies.
--
-- Path convention (enforced in lib/storage/paths.ts and by metadata-table
-- check constraints):   <workspace_id>/<character_id|campaign_id>/<uuid>-<name>
--
--   * All buckets are PRIVATE. Files are served only through short-lived
--     signed URLs created server-side after an authorisation check.
--   * Uploads/deletes are server-mediated: the server validates type/size and
--     issues a signed upload URL (service role). There are NO client
--     insert/update/delete policies on storage.objects.
--   * Members may read objects under their own workspace folder only.
--   * Size and MIME limits are enforced by Storage itself (bucket settings)
--     AND re-checked by the application before issuing an upload URL.
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('character-assets', 'character-assets', false, 20971520,
    array['image/png','image/jpeg','image/webp','image/gif','audio/mpeg','audio/wav','application/pdf']),
  ('reference-images', 'reference-images', false, 20971520,
    array['image/png','image/jpeg','image/webp']),
  ('generated-content', 'generated-content', false, 524288000,
    array['image/png','image/jpeg','image/webp','video/mp4','video/quicktime','video/webm','audio/mpeg','audio/wav']),
  ('campaign-assets', 'campaign-assets', false, 104857600,
    array['image/png','image/jpeg','image/webp','video/mp4','application/pdf'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Members read objects in their own workspace's folder, in Omnicore buckets only.
create policy omnicore_objects_member_read on storage.objects for select to authenticated
  using (
    bucket_id in ('character-assets','reference-images','generated-content','campaign-assets')
    and (select private.is_workspace_member(private.try_uuid((storage.foldername(name))[1]), 'viewer'))
  );
-- Intentionally no insert/update/delete policies for authenticated/anon:
-- writes go through the server (signed upload URLs, service-role deletes).
