-- 0005_raw_events_v1.4.0.sql
--
-- D-M6-00: dual logical event store — full redacted transport envelopes.
-- DB schema_version → 1.4.0. Does NOT change payload CURRENT_VERSION (1.3.0).
--
-- raw_events holds the wire-shaped envelope (snake_case top-level keys)
-- after redaction. Domain summaries stay in `events`; soft link is
-- events.correlation_id → raw_events.id (no FK — legacy correlations
-- may be non-raw).
--
-- Idempotency: CREATE TABLE / INDEX IF NOT EXISTS. Primary re-run
-- protection is schema_version in migrations.ts.

CREATE TABLE IF NOT EXISTS raw_events (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  type          TEXT NOT NULL,
  version       TEXT NOT NULL,
  actor_name    TEXT NOT NULL,
  actor_type    TEXT NOT NULL CHECK (actor_type IN ('human','worker','system')),
  -- Full wire envelope after redaction (FLAT snake_case JSON object as text).
  envelope_json TEXT NOT NULL,
  -- Denormalized helpers for list/filter without parsing JSON.
  source_tool   TEXT,
  source_command TEXT,
  -- 0 when classifier ignored; N when N domain events produced.
  domain_event_count INTEGER NOT NULL DEFAULT 0,
  -- Optional: original inbox/processed basename for forensics (nullable).
  source_file   TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_raw_events_session_created
  ON raw_events(session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_raw_events_project_created
  ON raw_events(project_id, created_at);

CREATE INDEX IF NOT EXISTS idx_events_correlation
  ON events(correlation_id);
