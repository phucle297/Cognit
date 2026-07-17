/**
 * D-M6-00 — RawEventStore unit tests.
 * Drives real RawEventStoreLive append/get/resolve against a migrated DB.
 */
import { describe, expect, it } from "vitest";
import { Effect, Either, Layer } from "effect";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import {
  CURRENT_VERSION,
  DB_SCHEMA_VERSION,
  DbConnection,
  LoggerNoop,
  NotFound,
  openDb,
  RawEventStore,
  RawEventStoreLive,
  RedactorLiveWithDefault,
  applyMigrations,
  decodeEnvelope,
  toWireEnvelope,
} from "../src";
import { makeRedactor } from "../src/redaction";

const withTempDb = (): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), "cognit-raw-")).then((dir) => path.join(dir, "cognit.db"));

// Crockford ULID alphabet only (no I/L/O/U) — required for EnvelopeSchema.
const PROJECT = "01HZZZZZZZZZZZZZZZZZZZZZZ1";
const SESSION = "01HZZZZZZZZZZZZZZZZZZZZZZ2";
const RAW_ID = "01HZZZZZZZZZZZZZZZZZZZZZZ3";
const SIBLING = "01HZZZZZZZZZZZZZZZZZZZZZZ4";
const ACTOR = "01HZZZZZZZZZZZZZZZZZZZZZZ5";
const IGNORE_ID = "01HZZZZZZZZZZZZZZZZZZZZZZ6";
const ORPHAN_ID = "01HZZZZZZZZZZZZZZZZZZZZZZ7";
const MISS_ID = "01HZZZZZZZZZZZZZZZZZZZZZZ8";

const seedProjectSession = (conn: {
  handle: { run: (sql: string, params?: unknown[]) => unknown };
}): void => {
  const now = new Date().toISOString();
  conn.handle.run(`INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)`, [
    PROJECT,
    "raw-test",
    now,
  ]);
  conn.handle.run(
    `INSERT INTO sessions (id, project_id, parent_session_id, goal, status, last_snapshot_event_id, created_at, closed_at)
     VALUES (?, ?, NULL, ?, 'active', NULL, ?, NULL)`,
    [SESSION, PROJECT, "raw store test", now],
  );
};

const makeLayer = (dbPath: string) => {
  const dbConn = Layer.effect(DbConnection, openDb(dbPath));
  const raw = Layer.provide(
    RawEventStoreLive,
    Layer.mergeAll(dbConn, RedactorLiveWithDefault, LoggerNoop),
  );
  return Layer.merge(raw, dbConn);
};

const wireEnvelope = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: RAW_ID,
  type: "raw_tool_signal",
  version: "1.3.0",
  session_id: SESSION,
  actor_name: "worker",
  actor_type: "worker",
  payload: {
    phase: "post",
    host: "grok",
    tool: "search_replace",
    path: "/tmp/file.ts",
    command: null,
    text: "tool search_replace → /tmp/file.ts",
    tool_input: {
      file_path: "/tmp/file.ts",
      old_string: "password=hunter2supersecretvalue",
      new_string: "const secret = process.env.KEY;",
    },
    tool_response: { ok: true },
  },
  source: { tool: "search_replace", command: "PostToolUse" },
  ...overrides,
});

describe("DB_SCHEMA_VERSION vs CURRENT_VERSION", () => {
  it("payload CURRENT_VERSION stays 1.3.0 while DB schema is 1.4.0", () => {
    expect(CURRENT_VERSION).toBe("1.3.0");
    expect(DB_SCHEMA_VERSION).toBe("1.4.0");
  });
});

describe("toWireEnvelope + decode round-trip", () => {
  it("rebuilds snake_case wire that decodeEnvelope accepts", () => {
    const wire = wireEnvelope();
    const decodedE = decodeEnvelope(wire);
    expect(Either.isRight(decodedE)).toBe(true);
    if (Either.isLeft(decodedE)) return;
    const rebuilt = toWireEnvelope(decodedE.right);
    expect(rebuilt["session_id"]).toBe(SESSION);
    expect(rebuilt["actor_name"]).toBe("worker");
    expect(rebuilt["actor_type"]).toBe("worker");
    expect(rebuilt["type"]).toBe("raw_tool_signal");
    const again = decodeEnvelope(rebuilt);
    expect(Either.isRight(again)).toBe(true);
  });
});

describe("RawEventStore.append", () => {
  it("inserts redacted envelope; first-write-wins body; refreshes domain_event_count", async () => {
    const dbPath = await withTempDb();
    const program = Effect.gen(function* () {
      const { handle } = yield* DbConnection;
      seedProjectSession({ handle });
      const store = yield* RawEventStore;

      const first = yield* store.append({
        id: RAW_ID,
        projectId: PROJECT,
        sessionId: SESSION,
        type: "raw_tool_signal",
        version: "1.3.0",
        actorName: "worker",
        actorType: "worker",
        envelope: wireEnvelope(),
        domainEventCount: 0,
        sourceFile: `${RAW_ID}.json`,
      });
      expect(first.domain_event_count).toBe(0);
      expect(first.source_tool).toBe("search_replace");
      expect(first.source_command).toBe("PostToolUse");
      // Redaction must scrub secrets in stored JSON (built-in password pattern)
      expect(first.envelope_json).not.toContain("hunter2supersecretvalue");
      expect(first.envelope_json).toMatch(/REDACTED:password/i);
      const originalJson = first.envelope_json;

      const second = yield* store.append({
        id: RAW_ID,
        projectId: PROJECT,
        sessionId: SESSION,
        type: "raw_tool_signal",
        version: "1.3.0",
        actorName: "worker",
        actorType: "worker",
        envelope: wireEnvelope({
          payload: { phase: "post", host: "grok", tool: "changed", text: "different body" },
        }),
        domainEventCount: 2,
        sourceFile: null,
      });
      expect(second.domain_event_count).toBe(2);
      // First-write-wins: envelope body unchanged
      expect(second.envelope_json).toBe(originalJson);
      // source_file kept from first write when second is null
      expect(second.source_file).toBe(`${RAW_ID}.json`);
    });
    await Effect.runPromise(program.pipe(Effect.provide(makeLayer(dbPath))) as Effect.Effect<void>);
  });
});

describe("RawEventStore.resolveForEventId", () => {
  it("resolves same-id domain, sibling correlation, ignore-only raw, and missing", async () => {
    const dbPath = await withTempDb();
    const program = Effect.gen(function* () {
      const { handle } = yield* DbConnection;
      seedProjectSession({ handle });
      const store = yield* RawEventStore;
      const now = new Date().toISOString();

      yield* store.append({
        id: RAW_ID,
        projectId: PROJECT,
        sessionId: SESSION,
        type: "raw_tool_signal",
        version: "1.3.0",
        actorName: "worker",
        actorType: "worker",
        envelope: wireEnvelope(),
        domainEventCount: 1,
      });

      // Domain same-id as raw
      handle.run(
        `INSERT INTO actors (id, type, name, trust_score, first_seen_at, last_seen_at)
         VALUES (?, 'worker', 'worker', 0.6, ?, ?)`,
        [ACTOR, now, now],
      );
      handle.run(
        `INSERT INTO events (
          id, project_id, session_id, actor_id, type, version, payload_json,
          source_json, artifact_refs_json, causation_id, correlation_id,
          confidence, parent_verification_id, linked_hypothesis_id, created_at
        ) VALUES (?, ?, ?, ?, 'action_recorded', '1.3.0', '{}',
          NULL, NULL, NULL, ?, NULL, NULL, NULL, ?)`,
        [RAW_ID, PROJECT, SESSION, ACTOR, RAW_ID, now],
      );

      const same = yield* store.resolveForEventId(RAW_ID);
      expect(same.row.id).toBe(RAW_ID);
      expect(same.domainEventId).toBe(RAW_ID);

      // Sibling domain with correlation to raw
      handle.run(
        `INSERT INTO events (
          id, project_id, session_id, actor_id, type, version, payload_json,
          source_json, artifact_refs_json, causation_id, correlation_id,
          confidence, parent_verification_id, linked_hypothesis_id, created_at
        ) VALUES (?, ?, ?, ?, 'verification_passed', '1.3.0', '{}',
          NULL, NULL, NULL, ?, NULL, NULL, NULL, ?)`,
        [SIBLING, PROJECT, SESSION, ACTOR, RAW_ID, now],
      );
      const sib = yield* store.resolveForEventId(SIBLING);
      expect(sib.row.id).toBe(RAW_ID);
      expect(sib.domainEventId).toBe(SIBLING);

      // Ignore-only raw (no domain) — separate id
      yield* store.append({
        id: IGNORE_ID,
        projectId: PROJECT,
        sessionId: SESSION,
        type: "raw_tool_signal",
        version: "1.3.0",
        actorName: "worker",
        actorType: "worker",
        envelope: wireEnvelope({ id: IGNORE_ID }),
        domainEventCount: 0,
      });
      const ignore = yield* store.resolveForEventId(IGNORE_ID);
      expect(ignore.row.id).toBe(IGNORE_ID);
      expect(ignore.domainEventId).toBeNull();

      // Missing
      const miss = yield* store.resolveForEventId(MISS_ID).pipe(Effect.either);
      expect(Either.isLeft(miss)).toBe(true);
      if (Either.isLeft(miss)) {
        expect(miss.left).toBeInstanceOf(NotFound);
      }

      // Domain without raw
      handle.run(
        `INSERT INTO events (
          id, project_id, session_id, actor_id, type, version, payload_json,
          source_json, artifact_refs_json, causation_id, correlation_id,
          confidence, parent_verification_id, linked_hypothesis_id, created_at
        ) VALUES (?, ?, ?, ?, 'observation_recorded', '1.3.0', '{}',
          NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
        [ORPHAN_ID, PROJECT, SESSION, ACTOR, now],
      );
      const orphan = yield* store.resolveForEventId(ORPHAN_ID).pipe(Effect.either);
      expect(Either.isLeft(orphan)).toBe(true);
    });
    await Effect.runPromise(program.pipe(Effect.provide(makeLayer(dbPath))) as Effect.Effect<void>);
  });
});

describe("applyMigrations includes raw_events at 1.4.0", () => {
  it("creates raw_events and sets schema_version to 1.4.0", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cognit-mig-raw-"));
    const dbPath = path.join(dir, "cognit.db");
    // openDb applies migrations
    const handleEffect = openDb(dbPath);
    const conn = await Effect.runPromise(handleEffect);
    try {
      const version = conn.handle.get<{ version: string }>(
        "SELECT version FROM schema_version WHERE id = 1",
      );
      expect(version?.version).toBe("1.4.0");
      const tables = conn.handle.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='raw_events'",
      );
      expect(tables.length).toBe(1);
      const idx = conn.handle.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_events_correlation'",
      );
      expect(idx.length).toBe(1);
    } finally {
      await Effect.runPromise(conn.handle.close());
    }
  });
});

// silence unused import if redactor helper not used
void makeRedactor;
void applyMigrations;
void SIBLING;
