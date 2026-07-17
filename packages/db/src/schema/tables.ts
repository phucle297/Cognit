/**
 * Plain SQL DDL — matches plan.xml <database_schema> section.
 * We use raw SQL via better-sqlite3 (no drizzle query builder yet) because
 * (a) the schema is small, (b) raw SQL is the audit-of-record for the
 * local-first single-file store, (c) the migration runner is also raw SQL.
 *
 * The corresponding TypeScript row types live in `./rows.ts` and are used
 * by the live `EventStore` implementation.
 */

export const TABLES_DDL: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS projects (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     repo_url TEXT,
     created_at TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS sessions (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL REFERENCES projects(id),
     parent_session_id TEXT REFERENCES sessions(id),
     goal TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('active','paused','closed')),
     last_snapshot_event_id TEXT REFERENCES events(id),
     created_at TEXT NOT NULL,
     closed_at TEXT
   )`,

  `CREATE TABLE IF NOT EXISTS actors (
     id TEXT PRIMARY KEY,
     type TEXT NOT NULL CHECK (type IN ('human','worker','system')),
     name TEXT UNIQUE NOT NULL,
     trust_score REAL NOT NULL DEFAULT 0,
     first_seen_at TEXT NOT NULL,
     last_seen_at TEXT NOT NULL,
     config_json TEXT
   )`,

  `CREATE TABLE IF NOT EXISTS events (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL REFERENCES projects(id),
     session_id TEXT NOT NULL REFERENCES sessions(id),
     actor_id TEXT NOT NULL REFERENCES actors(id),
     type TEXT NOT NULL,
     version TEXT NOT NULL DEFAULT '1.0.0',
     payload_json TEXT NOT NULL,
     source_json TEXT,
     artifact_refs_json TEXT,
     causation_id TEXT REFERENCES events(id),
     correlation_id TEXT,
     confidence REAL,
     parent_verification_id TEXT REFERENCES events(id),
     linked_hypothesis_id TEXT REFERENCES hypotheses(id),
     created_at TEXT NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS idx_events_session_created
     ON events(session_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_events_project_type_created
     ON events(project_id, type, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_events_actor_created
     ON events(actor_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_events_linked_hyp
     ON events(linked_hypothesis_id, created_at)`,

  `CREATE TABLE IF NOT EXISTS snapshots (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL REFERENCES sessions(id),
     event_id TEXT NOT NULL REFERENCES events(id),
     state_json TEXT NOT NULL,
     event_count INTEGER NOT NULL,
     created_at TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS artifacts (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL REFERENCES sessions(id),
     path TEXT NOT NULL,
     kind TEXT NOT NULL,
     sha256 TEXT NOT NULL,
     size_bytes INTEGER,
     archived_at TEXT,
     created_at TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS edges (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL REFERENCES sessions(id),
     edge_type TEXT NOT NULL,
     from_entity_type TEXT NOT NULL,
     from_entity_id TEXT NOT NULL,
     to_entity_type TEXT NOT NULL,
     to_entity_id TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_edges_session ON edges(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_entity_type, from_entity_id)`,
  `CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_entity_type, to_entity_id)`,

  `CREATE TABLE IF NOT EXISTS constraint_rules (
     id TEXT PRIMARY KEY,
     condition_json TEXT NOT NULL,
     actions_json TEXT NOT NULL,
     enabled INTEGER DEFAULT 1,
     created_at TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS schema_version (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     version TEXT NOT NULL,
     applied_at TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS hypotheses (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL REFERENCES sessions(id),
     title TEXT NOT NULL,
     text TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('active','weakened','rejected','promoted')),
     created_at TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS inbox_processed (
     id TEXT PRIMARY KEY,
     file TEXT NOT NULL,
     processed_at TEXT NOT NULL
   )`,
];

/**
 * Post-1.0.0 objects (not in TABLES_DDL; applied by migrations only):
 *   - hypotheses.gravity_fired_at          → 0003_gravity_fired_at_v1.2.0.sql
 *   - constraint_action_log                → 0004_constraint_action_log_v1.3.0.sql
 *   - raw_events + idx_events_correlation  → 0005_raw_events_v1.4.0.sql (D-M6-00)
 */

/** Pragmas applied at open. WAL = crash-safe + concurrent reader. */
export const PRAGMAS: ReadonlyArray<string> = [
  `PRAGMA journal_mode = WAL`,
  `PRAGMA synchronous = NORMAL`,
  `PRAGMA foreign_keys = ON`,
  `PRAGMA busy_timeout = 5000`,
];
