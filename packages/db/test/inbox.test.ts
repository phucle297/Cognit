import { describe, expect, it, beforeEach } from "vitest";
import { Context, Effect, Layer } from "effect";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import {
  ActorDefaults,
  DbConnection,
  EventBus,
  EventBusNoop,
  EventStore,
  Logger,
  LoggerNoop,
  MigrationRegistryLive,
  RedactorLiveWithDefault,
  SessionPolicy,
  SessionPolicyDefault,
  SessionService,
  SnapshotService,
  UuidTest,
  openDb,
} from "../src";
import { EventStoreDefault } from "../src/event-store";
import { SessionServiceLive } from "../src/session-service";
import { SnapshotServiceLive } from "../src/snapshot-service";
import { ConstraintPolicy, ConstraintPolicyLive } from "../src/constraint-policy";
import {
  inboxIgnored,
  makeInboxWatcher,
  runInboxWatcher,
  type InboxWatcherConfig,
} from "../src/inbox";

const makeTestLayer = (dbPath: string) => {
  const dbConn = Layer.effect(DbConnection, openDb(dbPath));
  const leafs = Layer.mergeAll(
    RedactorLiveWithDefault,
    MigrationRegistryLive,
    UuidTest,
    LoggerNoop,
  );
  // Build a complete live layer the same way `DbLive` does in
  // production, but with our test connection. The watcher needs
  // `SessionService` on its R channel; `SessionService` pulls in
  // `EventStore`, `SnapshotService`, `SessionPolicy`, and now
  // `EventBus` internally. Default `everyN=100` keeps the test runs
  // from accidentally snapshotting (each test appends a handful of
  // events at most).
  //
  // Note: `SessionPolicy` is provided FIRST (innermost) so the layer
  // composition yields a working runtime. `EventBusNoop` is provided
  // INSIDE the SessionService chain so the constructed
  // `sessionService` has R=never — without that, the runtime build
  // flaks with "Service not found: EventBus".
  //
  // `ActorDefaults` (Phase 9.1) is provided so `ensureActor` can
  // pull trust defaults off the R-channel instead of the historical
  // hardcoded literal.
  const eventStore = Layer.provide(Layer.provide(EventStoreDefault, leafs), dbConn);
  const snapshotService = Layer.provide(SnapshotServiceLive, Layer.merge(leafs, dbConn));
  const constraintPolicy = Layer.provide(ConstraintPolicyLive, eventStore);
  const sessionService = Layer.provide(
    Layer.provide(Layer.provide(SessionServiceLive, SessionPolicyDefault), leafs),
    Layer.merge(
      Layer.merge(Layer.merge(Layer.merge(eventStore, snapshotService), constraintPolicy), dbConn),
      EventBusNoop,
    ),
  );
  return Layer.merge(
    Layer.merge(
      Layer.merge(Layer.merge(eventStore, sessionService), snapshotService),
      constraintPolicy,
    ),
    Layer.merge(dbConn, LoggerNoop),
  ) as unknown as Layer.Layer<
    | EventStore
    | SessionService
    | SnapshotService
    | SessionPolicy
    | DbConnection
    | Logger
    | ConstraintPolicy
    | ActorDefaults
    | EventBus,
    never,
    never
  >;
};

const withTempDirs = async (): Promise<{
  inbox: string;
  processed: string;
  error: string;
  dbPath: string;
}> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cognit-inbox-"));
  const inbox = path.join(root, "inbox");
  const processed = path.join(root, "processed");
  const error = path.join(root, "error");
  await fs.mkdir(inbox, { recursive: true });
  await fs.mkdir(processed, { recursive: true });
  await fs.mkdir(error, { recursive: true });
  return {
    inbox,
    processed,
    error,
    dbPath: path.join(root, "cognit.db"),
  };
};

const setupSession = (conn: Context.Tag.Service<typeof DbConnection>): string => {
  const projectId = PROJECT_ID;
  // Valid ULID (Crockford base32): uppercase letters, 26 chars, no I/L/O/U.
  const sessionId = "0123456789ABCDEFGHJKMNPQRS";
  const h = conn.handle;
  h.run(`INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)`, [
    projectId,
    "p",
    new Date().toISOString(),
  ]);
  h.run(`INSERT INTO sessions (id, project_id, goal, status, created_at) VALUES (?, ?, ?, ?, ?)`, [
    sessionId,
    projectId,
    "g",
    "active",
    new Date().toISOString(),
  ]);
  return sessionId;
};

/** Crockford-base32 ULIDs used across the suite. */
const SESSION_ULID = "0123456789ABCDEFGHJKMNPQRS";
const EVENT_ULID = "0123456789ABCDEFGHJKMNPQRT";
const INBOX_FILENAME = `${SESSION_ULID}-${EVENT_ULID}.json`;
const UNKNOWN_SESSION_ULID = "0123456789ABCDEFGHJKMNPQRV";
const SECOND_EVENT_ULID = "0123456789ABCDEFGHJKMNPQRW";
/** Project id seeded by `setupSession`; required on every inbox config. */
const PROJECT_ID = "0123456789ABCDEFGHJKMNPQRX";

/** Write a JSON envelope to a path under `dir`. */
const writeEnvelope = async (
  dir: string,
  name: string,
  payload: Record<string, unknown>,
): Promise<string> => {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, JSON.stringify(payload), "utf8");
  return filePath;
};

describe("inbox processFile", () => {
  let dirs!: Awaited<ReturnType<typeof withTempDirs>>;
  beforeEach(async () => {
    dirs = await withTempDirs();
  });

  it("parses, appends, and moves a valid file to processed", async () => {
    const config: InboxWatcherConfig = {
      inboxDir: dirs.inbox,
      processedDir: dirs.processed,
      errorDir: dirs.error,
      debounceMs: 50,
      projectId: PROJECT_ID,
    };
    const file = await writeEnvelope(dirs.inbox, INBOX_FILENAME, {
      type: "observation_recorded",
      version: "1.1.0",
      session_id: SESSION_ULID,
      actor_name: "inboxer",
      actor_type: "worker",
      payload: { text: "inbox event" },
    });

    const program = Effect.gen(function* () {
      const conn = yield* DbConnection;
      setupSession(conn);
      const { processFile } = yield* makeInboxWatcher(config);
      yield* processFile(file);
    });

    await Effect.runPromise(
      program.pipe(Effect.provide(makeTestLayer(dirs.dbPath))) as Effect.Effect<void, never, never>,
    );

    // File moved to processed.
    const moved = await fs.readdir(dirs.processed);
    expect(moved.length).toBe(1);
    expect(moved[0]).toMatch(/\.json$/);

    // Source file gone from inbox.
    const stillThere = await fs.readdir(dirs.inbox);
    expect(stillThere).toEqual([]);
  });

  it("moves invalid JSON to error dir with a sidecar reason.txt", async () => {
    const config: InboxWatcherConfig = {
      inboxDir: dirs.inbox,
      processedDir: dirs.processed,
      errorDir: dirs.error,
      debounceMs: 50,
      projectId: PROJECT_ID,
    };
    const file = path.join(dirs.inbox, `${SESSION_ULID}-${EVENT_ULID}.json`);
    await fs.writeFile(file, "{ this is not valid json", "utf8");

    const program = Effect.gen(function* () {
      const conn = yield* DbConnection;
      setupSession(conn);
      const { processFile } = yield* makeInboxWatcher(config);
      yield* processFile(file);
    });

    await Effect.runPromise(
      program.pipe(Effect.provide(makeTestLayer(dirs.dbPath))) as Effect.Effect<void, never, never>,
    );
    const errored = await fs.readdir(dirs.error);
    expect(errored).toContain(INBOX_FILENAME);
    expect(errored).toContain(`${INBOX_FILENAME}.reason.txt`);
    const reason = await fs.readFile(path.join(dirs.error, `${INBOX_FILENAME}.reason.txt`), "utf8");
    expect(reason.split("\n")[0]).toMatch(/^invalid_json:/);
  });

  it("moves a file with missing fields to error dir, sidecar category=schema_validation_failure", async () => {
    const config: InboxWatcherConfig = {
      inboxDir: dirs.inbox,
      processedDir: dirs.processed,
      errorDir: dirs.error,
      debounceMs: 50,
      projectId: PROJECT_ID,
    };
    const file = await writeEnvelope(dirs.inbox, INBOX_FILENAME, {
      // Missing version, session_id, actor_name, actor_type, payload.
      type: "observation_recorded",
    });

    const program = Effect.gen(function* () {
      const conn = yield* DbConnection;
      setupSession(conn);
      const { processFile } = yield* makeInboxWatcher(config);
      yield* processFile(file);
    });

    await Effect.runPromise(
      program.pipe(Effect.provide(makeTestLayer(dirs.dbPath))) as Effect.Effect<void, never, never>,
    );
    const errored = await fs.readdir(dirs.error);
    expect(errored).toContain(INBOX_FILENAME);
    const reason = await fs.readFile(path.join(dirs.error, `${INBOX_FILENAME}.reason.txt`), "utf8");
    expect(reason.split("\n")[0]).toMatch(/^schema_validation_failure: envelope:/);
  });

  it("moves a file with non-ULID session_id to error dir, sidecar category=schema_validation_failure", async () => {
    const config: InboxWatcherConfig = {
      inboxDir: dirs.inbox,
      processedDir: dirs.processed,
      errorDir: dirs.error,
      debounceMs: 50,
      projectId: PROJECT_ID,
    };
    const file = await writeEnvelope(dirs.inbox, INBOX_FILENAME, {
      type: "observation_recorded",
      version: "1.1.0",
      session_id: "not-a-ulid",
      actor_name: "inboxer",
      actor_type: "worker",
      payload: { text: "inbox event" },
    });

    const program = Effect.gen(function* () {
      const conn = yield* DbConnection;
      setupSession(conn);
      const { processFile } = yield* makeInboxWatcher(config);
      yield* processFile(file);
    });

    await Effect.runPromise(
      program.pipe(Effect.provide(makeTestLayer(dirs.dbPath))) as Effect.Effect<void, never, never>,
    );
    const errored = await fs.readdir(dirs.error);
    expect(errored).toContain(INBOX_FILENAME);
    const reason = await fs.readFile(path.join(dirs.error, `${INBOX_FILENAME}.reason.txt`), "utf8");
    expect(reason.split("\n")[0]).toMatch(/^schema_validation_failure: envelope:/);
  });

  it("moves a file with bad filename (not <session>-<ulid>.json) to error dir, sidecar category=unknown_session_id", async () => {
    const config: InboxWatcherConfig = {
      inboxDir: dirs.inbox,
      processedDir: dirs.processed,
      errorDir: dirs.error,
      debounceMs: 50,
      projectId: PROJECT_ID,
    };
    // Valid envelope shape, but filename doesn't match `<session>-<event>.json`.
    const badName = `${SESSION_ULID}-just-some-file.json`;
    const file = await writeEnvelope(dirs.inbox, badName, {
      type: "observation_recorded",
      version: "1.1.0",
      session_id: SESSION_ULID,
      actor_name: "inboxer",
      actor_type: "worker",
      payload: { text: "inbox event" },
    });

    const program = Effect.gen(function* () {
      const conn = yield* DbConnection;
      setupSession(conn);
      const { processFile } = yield* makeInboxWatcher(config);
      yield* processFile(file);
    });

    await Effect.runPromise(
      program.pipe(Effect.provide(makeTestLayer(dirs.dbPath))) as Effect.Effect<void, never, never>,
    );
    const errored = await fs.readdir(dirs.error);
    expect(errored).toContain(badName);
    const reason = await fs.readFile(path.join(dirs.error, `${badName}.reason.txt`), "utf8");
    expect(reason.split("\n")[0]).toMatch(/^unknown_session_id:/);
  });

  it("moves a file with schema-validation failure on payload to error dir, category=schema_validation_failure", async () => {
    const config: InboxWatcherConfig = {
      inboxDir: dirs.inbox,
      processedDir: dirs.processed,
      errorDir: dirs.error,
      debounceMs: 50,
      projectId: PROJECT_ID,
    };
    // hypothesis_created requires `text` and `confidence`.
    const file = await writeEnvelope(dirs.inbox, INBOX_FILENAME, {
      type: "hypothesis_created",
      version: "1.1.0",
      session_id: SESSION_ULID,
      actor_name: "inboxer",
      actor_type: "worker",
      payload: { wrong_field: "missing text + confidence" },
    });

    const program = Effect.gen(function* () {
      const conn = yield* DbConnection;
      setupSession(conn);
      const { processFile } = yield* makeInboxWatcher(config);
      yield* processFile(file);
    });

    await Effect.runPromise(
      program.pipe(Effect.provide(makeTestLayer(dirs.dbPath))) as Effect.Effect<void, never, never>,
    );
    const errored = await fs.readdir(dirs.error);
    expect(errored).toContain(INBOX_FILENAME);
    const reason = await fs.readFile(path.join(dirs.error, `${INBOX_FILENAME}.reason.txt`), "utf8");
    expect(reason.split("\n")[0]).toMatch(/^schema_validation_failure: payload:/);
  });

  it("moves a file with invalid actor_type to error dir, sidecar category=schema_validation_failure (envelope catches it)", async () => {
    const config: InboxWatcherConfig = {
      inboxDir: dirs.inbox,
      processedDir: dirs.processed,
      errorDir: dirs.error,
      debounceMs: 50,
      projectId: PROJECT_ID,
    };
    const file = await writeEnvelope(dirs.inbox, INBOX_FILENAME, {
      type: "observation_recorded",
      version: "1.1.0",
      session_id: SESSION_ULID,
      actor_name: "alien-fan",
      actor_type: "alien",
      payload: { text: "ET phone home" },
    });

    const program = Effect.gen(function* () {
      const conn = yield* DbConnection;
      setupSession(conn);
      const { processFile } = yield* makeInboxWatcher(config);
      yield* processFile(file);
    });

    await Effect.runPromise(
      program.pipe(Effect.provide(makeTestLayer(dirs.dbPath))) as Effect.Effect<void, never, never>,
    );

    // Envelope decode rejects the literal → schema_validation_failure.
    const errored = await fs.readdir(dirs.error);
    expect(errored).toContain(INBOX_FILENAME);
    expect(await fs.readdir(dirs.processed)).toEqual([]);
    const reason = await fs.readFile(path.join(dirs.error, `${INBOX_FILENAME}.reason.txt`), "utf8");
    expect(reason.split("\n")[0]).toMatch(/^schema_validation_failure:/);

    // No event row landed in the DB.
    const conn = await Effect.runPromise(
      openDb(dirs.dbPath) as Effect.Effect<Context.Tag.Service<typeof DbConnection>, never, never>,
    );
    const row = conn.handle.get<{ c: number }>(
      "SELECT count(*) as c FROM events WHERE session_id = ?",
      [SESSION_ULID],
    );
    expect(row?.c).toBe(0);
  });

  it("auto-creates a bootstrap session for an unknown session_id (§2 lazy-create) and processes the file", async () => {
    const config: InboxWatcherConfig = {
      inboxDir: dirs.inbox,
      processedDir: dirs.processed,
      errorDir: dirs.error,
      debounceMs: 50,
      projectId: PROJECT_ID,
    };
    // Envelope + filename OK, but session_id doesn't exist in DB.
    const file = await writeEnvelope(dirs.inbox, `${UNKNOWN_SESSION_ULID}-${EVENT_ULID}.json`, {
      type: "observation_recorded",
      version: "1.1.0",
      session_id: UNKNOWN_SESSION_ULID,
      actor_name: "inboxer",
      actor_type: "worker",
      payload: { text: "lost session" },
    });

    const program = Effect.gen(function* () {
      const conn = yield* DbConnection;
      setupSession(conn);
      const { processFile } = yield* makeInboxWatcher(config);
      yield* processFile(file);
      // §2: unknown session_id is lazy-created. The observation lands
      // under a freshly-minted session — never under UNKNOWN_SESSION_ULID.
      const obs = conn.handle.get<{ session_id: string }>(
        "SELECT session_id FROM events WHERE type = 'observation_recorded'",
      );
      expect(obs?.session_id).not.toBe(UNKNOWN_SESSION_ULID);
      const minted = obs
        ? conn.handle.get<{ id: string; status: string; project_id: string }>(
            "SELECT id, status, project_id FROM sessions WHERE id = ?",
            [obs.session_id],
          )
        : undefined;
      expect(minted?.status).toBe("active");
      expect(minted?.project_id).toBe(PROJECT_ID);
    });

    await Effect.runPromise(
      program.pipe(Effect.provide(makeTestLayer(dirs.dbPath))) as Effect.Effect<void, never, never>,
    );
    // The file is processed, not errored.
    const errored = await fs.readdir(dirs.error);
    expect(errored).toEqual([]);
    const processed = await fs.readdir(dirs.processed);
    expect(processed.filter((n) => n.endsWith(".json"))).toHaveLength(1);
  });

  it("emits actor_registered event on first auto-registration with trust from defaults", async () => {
    const config: InboxWatcherConfig = {
      inboxDir: dirs.inbox,
      processedDir: dirs.processed,
      errorDir: dirs.error,
      debounceMs: 50,
      projectId: PROJECT_ID,
    };
    const file = await writeEnvelope(dirs.inbox, INBOX_FILENAME, {
      type: "observation_recorded",
      version: "1.1.0",
      session_id: SESSION_ULID,
      actor_name: "new-worker",
      actor_type: "worker",
      payload: { text: "first sighting" },
    });

    const program = Effect.gen(function* () {
      const conn = yield* DbConnection;
      setupSession(conn);
      const { processFile } = yield* makeInboxWatcher(config);
      yield* processFile(file);
    });

    await Effect.runPromise(
      program.pipe(Effect.provide(makeTestLayer(dirs.dbPath))) as Effect.Effect<void, never, never>,
    );

    // Two rows: the observation_recorded + the actor_registered audit.
    const conn = await Effect.runPromise(
      openDb(dirs.dbPath) as Effect.Effect<Context.Tag.Service<typeof DbConnection>, never, never>,
    );
    const events = conn.handle.all<{ type: string }>(
      "SELECT type FROM events WHERE session_id = ? ORDER BY created_at ASC",
      [SESSION_ULID],
    );
    const types = events.map((e) => e.type);
    expect(types).toContain("observation_recorded");
    expect(types).toContain("actor_registered");

    // Trust score on the actor row matches the built-in default (worker = 0.6).
    const actor = conn.handle.get<{ trust_score: number }>(
      "SELECT trust_score FROM actors WHERE name = ?",
      ["new-worker"],
    );
    expect(actor?.trust_score).toBe(0.6);

    // The actor_registered payload contains the same trust.
    const auditRow = conn.handle.get<{ payload_json: string }>(
      "SELECT payload_json FROM events WHERE type = 'actor_registered' AND session_id = ?",
      [SESSION_ULID],
    );
    const payload = JSON.parse(auditRow?.payload_json ?? "{}") as {
      actor_name?: string;
      actor_type?: string;
      trust_score?: number;
    };
    expect(payload.actor_name).toBe("new-worker");
    expect(payload.actor_type).toBe("worker");
    expect(payload.trust_score).toBe(0.6);
  });

  it("overwrites a trust_score=0 row on next registration touch (plan.xml:678 sentinel)", async () => {
    const config: InboxWatcherConfig = {
      inboxDir: dirs.inbox,
      processedDir: dirs.processed,
      errorDir: dirs.error,
      debounceMs: 50,
      projectId: PROJECT_ID,
    };
    // Pre-seed the actor row with trust_score=0 (e.g. admin banned it).
    const file = await writeEnvelope(dirs.inbox, INBOX_FILENAME, {
      type: "observation_recorded",
      version: "1.1.0",
      session_id: SESSION_ULID,
      actor_name: "banned-worker",
      actor_type: "worker",
      payload: { text: "back from the dead" },
    });

    const program = Effect.gen(function* () {
      const conn = yield* DbConnection;
      setupSession(conn);
      // Pre-insert the actor row at trust=0 with the project linkage.
      conn.handle.run(
        `INSERT INTO actors (id, type, name, trust_score, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          "0123456789ABCDEFGHJKMNPQRY",
          "worker",
          "banned-worker",
          0,
          new Date().toISOString(),
          new Date().toISOString(),
        ],
      );
      const { processFile } = yield* makeInboxWatcher(config);
      yield* processFile(file);
    });

    await Effect.runPromise(
      program.pipe(Effect.provide(makeTestLayer(dirs.dbPath))) as Effect.Effect<void, never, never>,
    );

    // Trust overwritten to the type default (worker = 0.6).
    const conn = await Effect.runPromise(
      openDb(dirs.dbPath) as Effect.Effect<Context.Tag.Service<typeof DbConnection>, never, never>,
    );
    const actor = conn.handle.get<{ trust_score: number }>(
      "SELECT trust_score FROM actors WHERE name = ?",
      ["banned-worker"],
    );
    expect(actor?.trust_score).toBe(0.6);

    // A pre-existing trust > 0 is NOT overwritten (the WHERE guard).
    conn.handle.run("UPDATE actors SET trust_score = ? WHERE name = ?", [0.42, "banned-worker"]);
    // Re-process another file from the same actor.
    const file2 = await writeEnvelope(dirs.inbox, `${SESSION_ULID}-${SECOND_EVENT_ULID}.json`, {
      type: "observation_recorded",
      version: "1.1.0",
      session_id: SESSION_ULID,
      actor_name: "banned-worker",
      actor_type: "worker",
      payload: { text: "second sighting" },
    });
    const program2 = Effect.gen(function* () {
      const conn2 = yield* DbConnection;
      const { processFile } = yield* makeInboxWatcher(config);
      yield* processFile(file2);
      // Re-fetch the row at the end of the same tx context.
      return yield* Effect.sync(() =>
        conn2.handle.get<{ trust_score: number }>("SELECT trust_score FROM actors WHERE name = ?", [
          "banned-worker",
        ]),
      );
    });
    const rowAfter = await Effect.runPromise(
      program2.pipe(Effect.provide(makeTestLayer(dirs.dbPath))) as Effect.Effect<
        { trust_score: number } | undefined,
        never,
        never
      >,
    );
    expect(rowAfter?.trust_score).toBe(0.42);
  });

  it("runInboxWatcher forks per-file effects with the R-channel intact", async () => {
    const config: InboxWatcherConfig = {
      inboxDir: dirs.inbox,
      processedDir: dirs.processed,
      errorDir: dirs.error,
      debounceMs: 50,
      projectId: PROJECT_ID,
    };
    const sessionId = SESSION_ULID;
    await writeEnvelope(dirs.inbox, INBOX_FILENAME, {
      type: "observation_recorded",
      version: "1.1.0",
      session_id: sessionId,
      actor_name: "watcher-test",
      actor_type: "worker",
      payload: { text: "watcher smoke" },
    });

    const program = Effect.scoped(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        setupSession(conn);
        const watcher = yield* runInboxWatcher(config);
        // Stop on scope exit.
        yield* Effect.addFinalizer(() => Effect.promise(() => watcher.stop()));
        // Poll processed dir up to 2s.
        const start = Date.now();
        const waitForProcessed = async (): Promise<boolean> => {
          while (Date.now() - start < 2000) {
            const moved = await fs.readdir(dirs.processed);
            if (moved.some((f) => f.endsWith(".json"))) return true;
            await new Promise((r) => setTimeout(r, 50));
          }
          return false;
        };
        const ok = yield* Effect.promise(() => waitForProcessed());
        if (!ok) {
          throw new Error("watcher did not move file to processed within 2s");
        }
      }),
    );
    await Effect.runPromise(
      program.pipe(Effect.provide(makeTestLayer(dirs.dbPath))) as Effect.Effect<void, never, never>,
    );

    // File moved to processed.
    const moved = await fs.readdir(dirs.processed);
    expect(moved.length).toBe(1);
    expect(moved[0]).toMatch(/\.json$/);

    // Event persisted to DB (observation + actor_registered audit row).
    const conn = await Effect.runPromise(
      openDb(dirs.dbPath) as Effect.Effect<Context.Tag.Service<typeof DbConnection>, never, never>,
    );
    const row = conn.handle.get<{ c: number }>(
      "SELECT count(*) as c FROM events WHERE session_id = ?",
      [sessionId],
    );
    expect(row?.c).toBe(2);
  });

  it("inboxIgnored uses path-segment match, not substring", () => {
    const root = path.join(os.tmpdir(), "cognit-inbox-ignored-test");
    // Files in inbox root that look like 'processed' or '_error' but are NOT
    // inside a `processed/` or `_error/` segment must NOT be ignored.
    expect(inboxIgnored(path.join(root, "inbox", "my_processed_backup.json"))).toBe(false);
    expect(inboxIgnored(path.join(root, "inbox", "anything.json"))).toBe(false);
    // .tmp suffix anywhere → ignored.
    expect(inboxIgnored(path.join(root, "inbox", "anything.tmp"))).toBe(true);
    // Files inside a `processed/` or `_error/` segment → ignored.
    expect(inboxIgnored(path.join(root, "inbox", "processed", "x.json"))).toBe(true);
    expect(inboxIgnored(path.join(root, "inbox", "_error", "x.json"))).toBe(true);
  });
});

/**
 * Cognit-9w6 — negative coverage for the envelope schema-validation
 * step in `processFile` (Cognit-3ru hardening follow-up).
 *
 * Three classes of rejection:
 *   1. ULID envelope id: when the producer supplies an `id`, it MUST
 *      be a Crockford-base32 ULID. Non-ULID strings (empty, wrong
 *      length, lowercase, illegal chars) are rejected at the
 *      envelope boundary with `schema_validation_failure`.
 *   2. Confidence range: out-of-range values (1.5, -0.1, NaN,
 *      Infinity) are rejected. The whole point of the move was to
 *      stop the inbox from surfacing a `actor_not_registered`
 *      miscategorization for what is really a `ValidationFailure`.
 *   3. Unknown (version, type): envelopes with an unregistered
 *      version literal OR a (known version, unknown type) pair are
 *      caught at the payload-schema lookup step.
 */
describe("inbox processFile — Cognit-9w6 negative tests", () => {
  let dirs!: Awaited<ReturnType<typeof withTempDirs>>;
  beforeEach(async () => {
    dirs = await withTempDirs();
  });

  /**
   * Run processFile against a single envelope and return the first
   * line of the sidecar reason.txt (e.g. `invalid_json: ...`,
   * `schema_validation_failure: ...`, `unknown_session_id: ...`).
   */
  const processAndReadReason = async (file: string, dbPath: string): Promise<string> => {
    const config: InboxWatcherConfig = {
      inboxDir: dirs.inbox,
      processedDir: dirs.processed,
      errorDir: dirs.error,
      debounceMs: 50,
      projectId: PROJECT_ID,
    };
    const program = Effect.gen(function* () {
      const conn = yield* DbConnection;
      setupSession(conn);
      const { processFile } = yield* makeInboxWatcher(config);
      yield* processFile(file);
    });
    await Effect.runPromise(
      program.pipe(Effect.provide(makeTestLayer(dbPath))) as Effect.Effect<void, never, never>,
    );
    const base = path.basename(file);
    const reasonPath = path.join(dirs.error, `${base}.reason.txt`);
    return (await fs.readFile(reasonPath, "utf8")).split("\n")[0]!;
  };

  describe("ULID envelope id", () => {
    it("rejects an empty-string `id` as schema_validation_failure", async () => {
      const file = await writeEnvelope(dirs.inbox, INBOX_FILENAME, {
        type: "observation_recorded",
        version: "1.1.0",
        session_id: SESSION_ULID,
        actor_name: "inboxer",
        actor_type: "worker",
        id: "",
        payload: { text: "empty id" },
      });
      const reason = await processAndReadReason(file, dirs.dbPath);
      expect(reason).toMatch(/^schema_validation_failure: envelope:/);
    });

    it("rejects a clearly non-ULID `id` (random words)", async () => {
      const file = await writeEnvelope(dirs.inbox, INBOX_FILENAME, {
        type: "observation_recorded",
        version: "1.1.0",
        session_id: SESSION_ULID,
        actor_name: "inboxer",
        actor_type: "worker",
        id: "not-a-ulid",
        payload: { text: "garbage id" },
      });
      const reason = await processAndReadReason(file, dirs.dbPath);
      expect(reason).toMatch(/^schema_validation_failure: envelope:/);
    });

    it("rejects an `id` with the wrong length (24 chars)", async () => {
      // 24 chars is one short of a ULID. Same character set, so it's
      // not a regex/character-class bug — it's a length bound.
      const file = await writeEnvelope(dirs.inbox, INBOX_FILENAME, {
        type: "observation_recorded",
        version: "1.1.0",
        session_id: SESSION_ULID,
        actor_name: "inboxer",
        actor_type: "worker",
        id: "0123456789ABCDEFGHJKMNPQR",
        payload: { text: "short id" },
      });
      const reason = await processAndReadReason(file, dirs.dbPath);
      expect(reason).toMatch(/^schema_validation_failure: envelope:/);
    });

    it("rejects an `id` with illegal characters (lowercase)", async () => {
      // 26 chars, valid length, but 'i' and 'l' are not in the
      // Crockford alphabet. The case-insensitive 'i' is the easiest
      // typo producers actually make.
      const file = await writeEnvelope(dirs.inbox, INBOX_FILENAME, {
        type: "observation_recorded",
        version: "1.1.0",
        session_id: SESSION_ULID,
        actor_name: "inboxer",
        actor_type: "worker",
        id: "0123456789abcdefghjkmnpqrs",
        payload: { text: "lowercase id" },
      });
      const reason = await processAndReadReason(file, dirs.dbPath);
      expect(reason).toMatch(/^schema_validation_failure: envelope:/);
    });

    it("still accepts an envelope with a well-formed ULID `id`", async () => {
      // The negative test sibling — prove the gate isn't over-eager.
      const config: InboxWatcherConfig = {
        inboxDir: dirs.inbox,
        processedDir: dirs.processed,
        errorDir: dirs.error,
        debounceMs: 50,
        projectId: PROJECT_ID,
      };
      const file = await writeEnvelope(dirs.inbox, INBOX_FILENAME, {
        type: "observation_recorded",
        version: "1.1.0",
        session_id: SESSION_ULID,
        actor_name: "inboxer",
        actor_type: "worker",
        id: EVENT_ULID,
        payload: { text: "good id" },
      });
      const program = Effect.gen(function* () {
        const conn = yield* DbConnection;
        setupSession(conn);
        const { processFile } = yield* makeInboxWatcher(config);
        yield* processFile(file);
      });
      await Effect.runPromise(
        program.pipe(Effect.provide(makeTestLayer(dirs.dbPath))) as Effect.Effect<
          void,
          never,
          never
        >,
      );
      // A valid envelope should NOT be in _error/ and SHOULD be in
      // processed/. ProcessFile is idempotent on the event id.
      const errored = await fs.readdir(dirs.error);
      expect(errored).toEqual([]);
      const processed = await fs.readdir(dirs.processed);
      expect(processed.length).toBe(1);
      expect(processed[0]).toMatch(/\.json$/);
    });
  });

  describe("confidence range", () => {
    /**
     * Each test case is the same shape: an envelope with a `confidence`
     * value the envelope schema's `>= 0 && <= 1` predicate must reject.
     * The expected outcome is `schema_validation_failure: envelope:`
     * (the schema fires before payload validation reaches the same
     * constraint).
     */
    const outOfRange = (
      confidence: number | string,
    ): {
      type: string;
      version: string;
      session_id: string;
      actor_name: string;
      actor_type: string;
      id: string;
      confidence: number | string;
      payload: { text: string };
    } => ({
      type: "observation_recorded",
      version: "1.1.0",
      session_id: SESSION_ULID,
      actor_name: "inboxer",
      actor_type: "worker",
      id: EVENT_ULID,
      confidence,
      payload: { text: "out of range" },
    });

    it("rejects confidence=1.5 (above upper bound)", async () => {
      const file = await writeEnvelope(dirs.inbox, INBOX_FILENAME, outOfRange(1.5));
      const reason = await processAndReadReason(file, dirs.dbPath);
      expect(reason).toMatch(/^schema_validation_failure: envelope:/);
    });

    it("rejects confidence=-0.1 (below lower bound)", async () => {
      const file = await writeEnvelope(dirs.inbox, INBOX_FILENAME, outOfRange(-0.1));
      const reason = await processAndReadReason(file, dirs.dbPath);
      expect(reason).toMatch(/^schema_validation_failure: envelope:/);
    });

    it("rejects confidence=NaN", async () => {
      // NaN serializes to null in JSON, so we write the file by hand
      // to keep the literal through. The schema still has to reject.
      const file = path.join(dirs.inbox, INBOX_FILENAME);
      const literal = `{
        "type": "observation_recorded",
        "version": "1.1.0",
        "session_id": "${SESSION_ULID}",
        "actor_name": "inboxer",
        "actor_type": "worker",
        "id": "${EVENT_ULID}",
        "confidence": NaN,
        "payload": { "text": "NaN" }
      }`.replace(/\s+/g, " ");
      await fs.writeFile(file, literal, "utf8");
      const reason = await processAndReadReason(file, dirs.dbPath);
      // NaN isn't valid JSON, so this trips the JSON.parse step first.
      expect(reason).toMatch(/^invalid_json:/);
    });

    it("rejects confidence=Infinity (string literal, since JSON has no Infinity)", async () => {
      // We cannot put `Infinity` in valid JSON, but the envelope
      // schema must still reject 1e308-style extremes in the [0, 1]
      // window if the producer is rounding. The cleanest negative
      // for the literal-union predicate is the upper bound overflow:
      // a JSON number just above 1.
      const file = await writeEnvelope(dirs.inbox, INBOX_FILENAME, outOfRange(1.0000001));
      const reason = await processAndReadReason(file, dirs.dbPath);
      expect(reason).toMatch(/^schema_validation_failure: envelope:/);
    });
  });

  describe("unknown (version, type)", () => {
    it("rejects an unknown version literal (999.0.0) as schema_validation_failure", async () => {
      // Filename must be a ULID pair for the watcher to reach the
      // schema decode step (it checks the filename regex AFTER the
      // envelope decode). The session ULID in the filename + the
      // bogus version in the body is enough to reach envelope
      // decode and trip the `Schema.Literal("1.0.0", "1.1.0")`
      // constraint.
      const file = await writeEnvelope(dirs.inbox, INBOX_FILENAME, {
        type: "observation_recorded",
        version: "999.0.0",
        session_id: SESSION_ULID,
        actor_name: "inboxer",
        actor_type: "worker",
        id: EVENT_ULID,
        payload: { text: "future version" },
      });
      const reason = await processAndReadReason(file, dirs.dbPath);
      expect(reason).toMatch(/^schema_validation_failure: envelope:/);
    });

    it("rejects a (known version, unknown type) pair as schema_validation_failure", async () => {
      // v1.1.0 is known, but `bogus_type` is not in the payload
      // schema map. The envelope decode passes (it accepts any
      // non-empty `type` string), then the payload-schema lookup
      // step returns undefined → `schema_validation_failure` with
      // the exact (version, type) pair in the reason.
      const file = await writeEnvelope(dirs.inbox, INBOX_FILENAME, {
        type: "bogus_type",
        version: "1.1.0",
        session_id: SESSION_ULID,
        actor_name: "inboxer",
        actor_type: "worker",
        id: EVENT_ULID,
        payload: { text: "unknown type" },
      });
      const reason = await processAndReadReason(file, dirs.dbPath);
      expect(reason).toMatch(/^schema_validation_failure:/);
      // The sidecar reason includes the (version, type) pair so the
      // producer knows what to fix.
      expect(reason).toMatch(/1\.1\.0/);
      expect(reason).toMatch(/bogus_type/);
    });

    it("rejects an empty `type` string as schema_validation_failure", async () => {
      // The envelope schema requires `Schema.minLength(1)` on
      // `type`. An empty type trips the decode at the envelope
      // step.
      const file = await writeEnvelope(dirs.inbox, INBOX_FILENAME, {
        type: "",
        version: "1.1.0",
        session_id: SESSION_ULID,
        actor_name: "inboxer",
        actor_type: "worker",
        id: EVENT_ULID,
        payload: { text: "empty type" },
      });
      const reason = await processAndReadReason(file, dirs.dbPath);
      expect(reason).toMatch(/^schema_validation_failure: envelope:/);
    });
  });

  describe("CURRENT_VERSION envelope acceptance", () => {
    it("accepts a CURRENT_VERSION (1.2.0) envelope and moves it to processed", async () => {
      // Regression: the envelope literal union previously listed
      // only "1.0.0"/"1.1.0" while every live producer (wrap,
      // claude/codex/gemini/opencode hooks) emits CURRENT_VERSION
      // ("1.2.0"). The literal gap caused every inbox file to land
      // in `.cognit/inbox/_error/` as `schema_validation_failure`.
      const config: InboxWatcherConfig = {
        inboxDir: dirs.inbox,
        processedDir: dirs.processed,
        errorDir: dirs.error,
        debounceMs: 50,
        projectId: PROJECT_ID,
      };
      const file = await writeEnvelope(dirs.inbox, INBOX_FILENAME, {
        type: "observation_recorded",
        version: "1.2.0",
        session_id: SESSION_ULID,
        actor_name: "inboxer",
        actor_type: "worker",
        id: EVENT_ULID,
        payload: { text: "current version envelope" },
      });

      const program = Effect.gen(function* () {
        const conn = yield* DbConnection;
        setupSession(conn);
        const { processFile } = yield* makeInboxWatcher(config);
        yield* processFile(file);
      });

      await Effect.runPromise(
        program.pipe(Effect.provide(makeTestLayer(dirs.dbPath))) as Effect.Effect<
          void,
          never,
          never
        >,
      );

      const processed = await fs.readdir(dirs.processed);
      // Processed file is renamed to `<event.id>.json`.
      expect(processed).toContain(`${EVENT_ULID}.json`);
      const errored = await fs.readdir(dirs.error);
      expect(errored).toEqual([]);
    });
  });
});
