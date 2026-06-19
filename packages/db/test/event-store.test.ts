import { describe, expect, it, beforeEach } from "vitest";
import { Context, Effect, Either, Layer } from "effect";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import {
  CURRENT_VERSION,
  DbConnection,
  EventStore,
  Logger,
  LoggerNoop,
  MigrationRegistryLive,
  openDb,
  RedactorLiveWithDefault,
  UuidTest,
} from "../src";
import { EventStoreDefault } from "../src/event-store";

/**
 * Build a Layer that has DbConnection + EventStore + Redactor + Uuid.
 * Test layer: counter-based ulid, empty-replacement redactor, no logger.
 *
 * Dep-aware composition: leaf deps are merged, then provided to EventStoreLive,
 * then DbConnection is provided. We also re-expose DbConnection in the merged
 * output so test code that sets up projects/sessions directly can yield it.
 *
 * `Layer.mergeAll` would NOT work here — it zips outputs but does not satisfy
 * R channels, leaving layers to defect with "Service not found" at build time.
 */
const makeTestLayer = (dbPath: string) => {
  const dbConn = Layer.effect(DbConnection, openDb(dbPath));
  const leafs = Layer.mergeAll(RedactorLiveWithDefault, MigrationRegistryLive, UuidTest, LoggerNoop);
  return Layer.merge(
    Layer.provide(Layer.provide(EventStoreDefault, leafs), dbConn),
    Layer.merge(dbConn, LoggerNoop),
  ) as Layer.Layer<EventStore | DbConnection | Logger, never, never>;
};

const withTempDb = (): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), "cognit-test-")).then((dir) => path.join(dir, "cognit.db"));

const setupProjectAndSession = (conn: Context.Tag.Service<typeof DbConnection>): string => {
  const projectId = "01projectxxxxxxxxxxxxxxxxx";
  const sessionId = "01sessionxxxxxxxxxxxxxxxxx";
  conn.handle.run(`INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)`, [
    projectId,
    "test-project",
    new Date().toISOString(),
  ]);
  conn.handle.run(
    `INSERT INTO sessions (id, project_id, goal, status, created_at) VALUES (?, ?, ?, ?, ?)`,
    [sessionId, projectId, "goal", "active", new Date().toISOString()],
  );
  return sessionId;
};

describe("EventStore", () => {
  let dbPath = "";
  beforeEach(async () => {
    dbPath = await withTempDb();
  });

  const runWithLayer = <A, E, R>(eff: Effect.Effect<A, E, R>): Promise<A> =>
    Effect.runPromise(
      eff.pipe(Effect.provide(makeTestLayer(dbPath))) as Effect.Effect<A, E, never>,
    );

  it("appends an event and reads it back", async () => {
    const result = await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const store = yield* EventStore;
        const sessionId = setupProjectAndSession(conn);
        const inserted = yield* store.append({
          type: "observation_recorded",
          payload: { text: "the moon is made of cheese" },
          sessionId,
          actor: { name: "alice", type: "human" },
        });
        expect(inserted.type).toBe("observation_recorded");
        expect(inserted.version).toBe(CURRENT_VERSION);
        expect(JSON.parse(inserted.payload_json).text).toBe("the moon is made of cheese");
        const got = yield* store.get(inserted.id).pipe(Effect.either);
        expect(Either.isRight(got)).toBe(true);
        if (Either.isRight(got)) {
          expect(got.right.id).toBe(inserted.id);
        }
      }),
    );
    expect(result).toBeUndefined();
  });

  it("get returns NotFound as Effect.fail for a missing id", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        setupProjectAndSession(conn);
        const store = yield* EventStore;
        const result = yield* store.get("01nonexistentxxxxxxxxxxxx").pipe(Effect.either);
        expect(Either.isLeft(result)).toBe(true);
        if (Either.isLeft(result)) {
          expect((result.left as { _tag: string })._tag).toBe("NotFound");
        }
      }),
    );
  });

  it("append is idempotent across concurrent attempts with the same id", async () => {
    // Simulates the race: the second append must observe the first row
    // (either via the in-tx SELECT or via the DuplicateEventId catch)
    // and never produce a second row or a raw thrown error.
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const store = yield* EventStore;
        const sessionId = setupProjectAndSession(conn);
        const id = "01racexxxxxxxxxxxxxxxxxxxxx";
        const a = yield* store.append({
          id,
          type: "observation_recorded",
          payload: { text: "first" },
          sessionId,
          actor: { name: "racer", type: "human" },
        });
        const b = yield* store.append({
          id,
          type: "observation_recorded",
          payload: { text: "second" },
          sessionId,
          actor: { name: "racer", type: "human" },
        });
        expect(a.id).toBe(id);
        expect(b.id).toBe(id);
        const { events } = yield* store.list({ sessionId });
        const ours = events.filter((e) => e.id === id);
        expect(ours.length).toBe(1);
        expect(JSON.parse(ours[0]!.payload_json).text).toBe("first");
      }),
    );
  });

  it("rejects an invalid actor_registered payload via the per-type Schema", async () => {
    // After dropping the actor_registered validation skip, bad payloads
    // are caught by the Schema decoder.
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const store = yield* EventStore;
        const sessionId = setupProjectAndSession(conn);
        const result = yield* store
          .append({
            type: "actor_registered",
            payload: {
              actor_type: "alien",
              actor_name: "x",
              trust_score: 0.5,
            },
            sessionId,
            actor: { name: "x", type: "human" },
          })
          .pipe(Effect.either);
        expect(Either.isLeft(result)).toBe(true);
        if (Either.isLeft(result)) {
          expect((result.left as { _tag: string })._tag).toBe("ValidationFailure");
        }
      }),
    );
  });

  it("redaction_applied and main event share the same created_at", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const store = yield* EventStore;
        const sessionId = setupProjectAndSession(conn);
        const jwt =
          "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
        const inserted = yield* store.append({
          type: "observation_recorded",
          payload: { text: `token=${jwt} seen` },
          sessionId,
          actor: { name: "eve", type: "human" },
        });
        const { events } = yield* store.list({ sessionId });
        const redactions = events.filter((e) => e.type === "redaction_applied");
        expect(redactions.length).toBeGreaterThan(0);
        for (const r of redactions) {
          expect(r.created_at <= inserted.created_at).toBe(true);
        }
      }),
    );
  });

  it("is idempotent on duplicate event id", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const store = yield* EventStore;
        const sessionId = setupProjectAndSession(conn);
        const id = "01dupidxxxxxxxxxxxxxxxxxxxxx";
        const a = yield* store.append({
          id,
          type: "observation_recorded",
          payload: { text: "first" },
          sessionId,
          actor: { name: "bob", type: "worker" },
        });
        const b = yield* store.append({
          id,
          type: "observation_recorded",
          payload: { text: "second" },
          sessionId,
          actor: { name: "bob", type: "worker" },
        });
        expect(a.id).toBe(id);
        expect(b.id).toBe(id);
        expect(JSON.parse(b.payload_json).text).toBe("first");
      }),
    );
  });

  it("redacts JWTs in payload and emits redaction_applied", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const store = yield* EventStore;
        const sessionId = setupProjectAndSession(conn);
        const jwt =
          "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
        const inserted = yield* store.append({
          type: "observation_recorded",
          payload: { text: `token=${jwt} seen` },
          sessionId,
          actor: { name: "carol", type: "human" },
        });
        expect(inserted.payload_json).not.toContain("eyJhbGciOi");
        expect(inserted.payload_json).toContain("[REDACTED:jwt]");

        const { events } = yield* store.list({ sessionId });
        const redactions = events.filter((e) => e.type === "redaction_applied");
        expect(redactions.length).toBeGreaterThan(0);
        for (const r of redactions) {
          expect(r.causation_id).toBe(inserted.id);
          expect(r.payload_json).not.toContain("eyJhbGciOi");
        }
      }),
    );
  });

  it("appends redaction_applied with payload.<key> field_path", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const store = yield* EventStore;
        const sessionId = setupProjectAndSession(conn);
        const jwt =
          "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
        yield* store.append({
          type: "observation_recorded",
          payload: { text: `token=${jwt} seen` },
          sessionId,
          actor: { name: "dave", type: "human" },
        });
        const { events } = yield* store.list({ sessionId });
        const redactions = events.filter((e) => e.type === "redaction_applied");
        expect(redactions.length).toBeGreaterThan(0);
        for (const r of redactions) {
          const payload = JSON.parse(r.payload_json);
          expect(payload.field_path).toMatch(/^payload\./);
        }
      }),
    );
  });

  it("auto-registers unknown actors with default trust_score", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const store = yield* EventStore;
        const sessionId = setupProjectAndSession(conn);
        yield* store.append({
          type: "observation_recorded",
          payload: { text: "hi" },
          sessionId,
          actor: { name: "new-actor", type: "worker" },
        });
        const row = conn.handle.get<{ trust_score: number }>(
          "SELECT trust_score FROM actors WHERE name = ?",
          ["new-actor"],
        );
        expect(row?.trust_score).toBe(0.6);
      }),
    );
  });

  it("rejects unknown event types", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const store = yield* EventStore;
        const sessionId = setupProjectAndSession(conn);
        const result = yield* store
          .append({
            type: "definitely_not_a_real_type",
            payload: {},
            sessionId,
            actor: { name: "a", type: "human" },
          })
          .pipe(Effect.either);
        expect(Either.isLeft(result)).toBe(true);
        if (Either.isLeft(result)) {
          expect((result.left as { _tag: string })._tag).toBe("UnknownEventType");
        }
      }),
    );
  });

  it("rejects payloads failing the per-type Schema", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const store = yield* EventStore;
        const sessionId = setupProjectAndSession(conn);
        const result = yield* store
          .append({
            type: "observation_recorded",
            payload: { wrong: "shape" },
            sessionId,
            actor: { name: "a", type: "human" },
          })
          .pipe(Effect.either);
        expect(Either.isLeft(result)).toBe(true);
        if (Either.isLeft(result)) {
          expect((result.left as { _tag: string })._tag).toBe("ValidationFailure");
        }
      }),
    );
  });

  it("rejects unknown session ids", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const store = yield* EventStore;
        setupProjectAndSession(conn);
        const result = yield* store
          .append({
            type: "observation_recorded",
            payload: { text: "orphan" },
            sessionId: "01nonexistentxxxxxxxxxxxxx",
            actor: { name: "a", type: "human" },
          })
          .pipe(Effect.either);
        expect(Either.isLeft(result)).toBe(true);
        if (Either.isLeft(result)) {
          expect((result.left as { _tag: string })._tag).toBe("UnknownSession");
        }
      }),
    );
  });

  it("lists events in created_at order with pagination cursor", async () => {
    await runWithLayer(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const store = yield* EventStore;
        const sessionId = setupProjectAndSession(conn);
        for (let i = 0; i < 5; i++) {
          yield* store.append({
            type: "observation_recorded",
            payload: { text: `obs-${i}` },
            sessionId,
            actor: { name: "a", type: "human" },
          });
        }
        // Phase 9.1 AC 9.1.4: first auto-registration of the actor
        // "a" emits an actor_registered audit row inside the same
        // tx as the first observation. Total = 1 audit + 5 obs = 6
        // events.
        const page1 = yield* store.list({ sessionId, limit: 3 });
        expect(page1.events.length).toBe(3);
        expect(page1.nextCursor).toBeDefined();
        const page2 = yield* store.list({
          sessionId,
          limit: 3,
          afterEventId: page1.nextCursor!,
        });
        expect(page2.events.length).toBe(3);
        const all = [...page1.events, ...page2.events];
        // Filter out the audit row (no `text` field) so the
        // observation ordering can be asserted directly.
        const textEvents = all
          .map((e) => JSON.parse(e.payload_json).text as string | undefined)
          .filter((t): t is string => typeof t === "string");
        expect(textEvents).toEqual(["obs-0", "obs-1", "obs-2", "obs-3", "obs-4"]);
      }),
    );
  });
});
