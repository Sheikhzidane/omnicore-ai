# Supabase snapshots

`scripts/backup-supabase.mjs` writes JSON snapshots here. Run it locally or via the
**manual** GitHub workflow `.github/workflows/backup.yml`, which uploads the snapshot as a
private workflow artifact kept for 7 days.

**Snapshots are git-ignored and must never be committed.** They contain personal data
(for example, subscriber email addresses). For production, use Supabase's managed backups
and point-in-time recovery.
