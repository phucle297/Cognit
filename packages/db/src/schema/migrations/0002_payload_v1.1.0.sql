-- 0002_payload_v1.1.0.sql
--
-- Adds columns to the `events` table for verification outcomes and an
-- index on `artifacts.archived_at` for the GC helper. Idempotency is
-- guaranteed by the migration runner's `schema_version` check; this
-- file is the canonical audit-of-record and is loaded at runtime by
-- `packages/db/src/schema/migrations.ts`.
--
-- New `events` columns are nullable (no NOT NULL, no DEFAULT other than
-- the implicit NULL), so existing rows continue to read back cleanly
-- with the new fields set to NULL. The reducer in `@cognit/core` learns
-- to read these fields from the v1.1.0 payload schema.
--
-- `created_artifact_id` references `artifacts(id)`. SQLite supports
-- `REFERENCES` inside `ADD COLUMN` since 3.6.19; the existing
-- `PRAGMA foreign_keys = ON` (set by `PRAGMAS` in `tables.ts`) will
-- enforce the constraint on insert.

ALTER TABLE events
  ADD COLUMN stdout_excerpt TEXT;

ALTER TABLE events
  ADD COLUMN exit_code INTEGER;

ALTER TABLE events
  ADD COLUMN duration_ms INTEGER;

ALTER TABLE events
  ADD COLUMN created_artifact_id TEXT REFERENCES artifacts(id);

CREATE INDEX IF NOT EXISTS idx_artifacts_archived
  ON artifacts(archived_at);
