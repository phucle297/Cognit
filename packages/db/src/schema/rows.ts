/**
 * Row shapes (mirror DDL exactly). Used by the live EventStore.
 *
 * SQLite stores timestamps as TEXT (ISO 8601). Parse with
 * `new Date(row.created_at)` if you need a Date object.
 */

export interface ProjectRow {
  id: string;
  name: string;
  repo_url: string | null;
  created_at: string;
}

export interface SessionRow {
  id: string;
  project_id: string;
  parent_session_id: string | null;
  goal: string;
  status: "active" | "paused" | "closed";
  last_snapshot_event_id: string | null;
  created_at: string;
  closed_at: string | null;
}

export interface ActorRow {
  id: string;
  type: "human" | "worker" | "system";
  name: string;
  trust_score: number;
  first_seen_at: string;
  last_seen_at: string;
  config_json: string | null;
}

export interface EventRow {
  id: string;
  project_id: string;
  session_id: string;
  actor_id: string;
  type: string;
  version: string;
  payload_json: string;
  source_json: string | null;
  artifact_refs_json: string | null;
  causation_id: string | null;
  correlation_id: string | null;
  confidence: number | null;
  parent_verification_id: string | null;
  linked_hypothesis_id: string | null;
  // SQLite TEXT (ISO 8601). Parse with `new Date(row.created_at)` if you need a Date.
  created_at: string;
}

export interface SnapshotRow {
  id: string;
  session_id: string;
  event_id: string;
  state_json: string;
  event_count: number;
  created_at: string;
}

export interface ArtifactRow {
  id: string;
  session_id: string;
  path: string;
  kind: string;
  sha256: string;
  size_bytes: number | null;
  archived_at: string | null;
  created_at: string;
}

export interface EdgeRow {
  id: string;
  session_id: string;
  edge_type: string;
  from_entity_type: string;
  from_entity_id: string;
  to_entity_type: string;
  to_entity_id: string;
  created_at: string;
}

export interface ConstraintRuleRow {
  id: string;
  condition_json: string;
  actions_json: string;
  enabled: number | null;
  created_at: string;
}

export interface SchemaVersionRow {
  id: number;
  version: string;
  applied_at: string;
}

export interface InboxProcessedRow {
  id: string;
  file: string;
  processed_at: string;
}
