import { describe, expect, it, beforeEach } from "vitest";
import { Context, Effect, Layer } from "effect";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import {
  DbConnection,
  EventStore,
  Logger,
  LoggerNoop,
  MigrationRegistryLive,
  RedactorLive,
  UuidTest,
  openDb,
} from "../src";
import { EventStoreLive } from "../src/event-store";
import { inboxIgnored, makeInboxWatcher, runInboxWatcher, type InboxWatcherConfig } from "../src/inbox";

const makeTestLayer = (dbPath: string) => {
  const dbConn = Layer.effect(DbConnection, openDb(dbPath));
  const leafs = Layer.mergeAll(
    RedactorLive,
    MigrationRegistryLive,
    UuidTest,
    LoggerNoop,
  );
  return Layer.merge(
    Layer.provide(Layer.provide(EventStoreLive, leafs), dbConn),
    Layer.merge(dbConn, LoggerNoop),
  ) as Layer.Layer<EventStore | DbConnection | Logger, never, never>;
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
  const projectId = "01projectxxxxxxxxxxxxxxxxx";
  const sessionId = "01sessionxxxxxxxxxxxxxxxxx";
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
    };
    const file = path.join(dirs.inbox, "01testevent00000000000000.json");
    const payload = {
      type: "observation_recorded",
      session_id: "01sessionxxxxxxxxxxxxxxxxx",
      actor_name: "inboxer",
      actor_type: "worker",
      payload: { text: "inbox event" },
    };
    await fs.writeFile(file, JSON.stringify(payload), "utf8");

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

  it("moves invalid JSON to error dir", async () => {
    const config: InboxWatcherConfig = {
      inboxDir: dirs.inbox,
      processedDir: dirs.processed,
      errorDir: dirs.error,
      debounceMs: 50,
    };
    const file = path.join(dirs.inbox, "bad.json");
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
    expect(await fs.readdir(dirs.error)).toEqual(["bad.json"]);
  });

  it("moves a file with missing fields to error dir", async () => {
    const config: InboxWatcherConfig = {
      inboxDir: dirs.inbox,
      processedDir: dirs.processed,
      errorDir: dirs.error,
      debounceMs: 50,
    };
    const file = path.join(dirs.inbox, "incomplete.json");
    await fs.writeFile(
      file,
      JSON.stringify({ type: "observation_recorded" /* missing session_id, actor_name, etc. */ }),
      "utf8",
    );

    const program = Effect.gen(function* () {
      const conn = yield* DbConnection;
      setupSession(conn);
      const { processFile } = yield* makeInboxWatcher(config);
      yield* processFile(file);
    });

    await Effect.runPromise(
      program.pipe(Effect.provide(makeTestLayer(dirs.dbPath))) as Effect.Effect<void, never, never>,
    );
    expect(await fs.readdir(dirs.error)).toEqual(["incomplete.json"]);
  });

  it("moves a file with invalid actor_type to error dir, no DB row", async () => {
    const config: InboxWatcherConfig = {
      inboxDir: dirs.inbox,
      processedDir: dirs.processed,
      errorDir: dirs.error,
      debounceMs: 50,
    };
    const file = path.join(dirs.inbox, "bad-actor.json");
    const payload = {
      type: "observation_recorded",
      session_id: "01sessionxxxxxxxxxxxxxxxxx",
      actor_name: "alien-fan",
      actor_type: "alien",
      payload: { text: "ET phone home" },
    };
    await fs.writeFile(file, JSON.stringify(payload), "utf8");

    const program = Effect.gen(function* () {
      const conn = yield* DbConnection;
      setupSession(conn);
      const { processFile } = yield* makeInboxWatcher(config);
      yield* processFile(file);
    });

    await Effect.runPromise(
      program.pipe(Effect.provide(makeTestLayer(dirs.dbPath))) as Effect.Effect<void, never, never>,
    );

    // File moved to error/, not processed/.
    expect(await fs.readdir(dirs.error)).toEqual(["bad-actor.json"]);
    expect(await fs.readdir(dirs.processed)).toEqual([]);

    // No event row landed in the DB.
    const conn = await Effect.runPromise(openDb(dirs.dbPath) as Effect.Effect<Context.Tag.Service<typeof DbConnection>, never, never>);
    const row = conn.handle.get<{ c: number }>(
      "SELECT count(*) as c FROM events WHERE session_id = ?",
      ["01sessionxxxxxxxxxxxxxxxxx"],
    );
    expect(row?.c).toBe(0);
  });

  it("runInboxWatcher forks per-file effects with the R-channel intact", async () => {
    const config: InboxWatcherConfig = {
      inboxDir: dirs.inbox,
      processedDir: dirs.processed,
      errorDir: dirs.error,
      debounceMs: 50,
    };
    const sessionId = "01sessionxxxxxxxxxxxxxxxxx";
    const file = path.join(dirs.inbox, "01watcherevent0000000000000.json");
    const payload = {
      type: "observation_recorded",
      session_id: sessionId,
      actor_name: "watcher-test",
      actor_type: "worker",
      payload: { text: "watcher smoke" },
    };
    await fs.writeFile(file, JSON.stringify(payload), "utf8");

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

    // Event persisted to DB.
    const conn = await Effect.runPromise(openDb(dirs.dbPath) as Effect.Effect<Context.Tag.Service<typeof DbConnection>, never, never>);
    const row = conn.handle.get<{ c: number }>(
      "SELECT count(*) as c FROM events WHERE session_id = ?",
      [sessionId],
    );
    expect(row?.c).toBe(1);
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
