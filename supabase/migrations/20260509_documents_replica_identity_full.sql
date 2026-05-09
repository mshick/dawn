-- Emit full row payloads in WAL for UPDATE / DELETE so Supabase realtime's
-- postgres_changes hands the chip rail the complete `documents` row (including
-- `name`, `kind`, `byte_size`) on a `processing → ready` transition. With the
-- default replica identity (PK only), realtime sends only the PK + columns that
-- changed in the UPDATE, which causes consumers that replace the row to lose
-- non-changed fields.

alter table public.documents replica identity full;
