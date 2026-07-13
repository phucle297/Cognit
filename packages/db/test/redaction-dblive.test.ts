/**
 * D-M1-04: user redaction patterns must apply through DbLive's Layer
 * composition (the previous provide(RedactorLiveWithDefault, cfg) was a no-op).
 */
import { describe, expect, it, beforeEach } from "vitest";
import { Context, Effect, Layer } from "effect";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import {
  ActorDefaultsBuiltIn,
  actorDefaultsLayer,
  DbConnection,
  DbLive,
  EventBusNoop,
  EventStore,
  RedactionConfig,
  SessionPolicyDefault,
} from "../src";

const withTempDb = (): Promise<string> =>
  fs.mkdtemp(path.join(os.tmpdir(), "cognit-redact-dblive-")).then((dir) =>
    path.join(dir, "cognit.db"),
  );

const seed = (conn: Context.Tag.Service<typeof DbConnection>): string => {
  const projectId = "01projectxxxxxxxxxxxxxxxxx";
  const sessionId = "01sessionxxxxxxxxxxxxxxxxx";
  conn.handle.run(`INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)`, [
    projectId,
    "redact-test",
    new Date().toISOString(),
  ]);
  conn.handle.run(
    `INSERT INTO sessions (id, project_id, goal, status, created_at) VALUES (?, ?, ?, ?, ?)`,
    [sessionId, projectId, "goal", "active", new Date().toISOString()],
  );
  return sessionId;
};

describe("DbLive redaction config (D-M1-04)", () => {
  let dbPath = "";
  beforeEach(async () => {
    dbPath = await withTempDb();
  });

  it("applies user patterns from RedactionConfig through DbLive on append", async () => {
    const redactionCfg = Layer.succeed(RedactionConfig)({
      userPatterns: [
        {
          name: "user_phone",
          regex: "\\b\\d{3}-\\d{3}-\\d{4}\\b",
          replacement: "[REDACTED:user_phone]",
        },
      ],
    });
    const layer = Layer.provideMerge(
      Layer.provideMerge(
        DbLive(dbPath, SessionPolicyDefault, redactionCfg),
        EventBusNoop,
      ),
      actorDefaultsLayer(ActorDefaultsBuiltIn),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const store = yield* EventStore;
        const sessionId = seed(conn);
        const inserted = yield* store.append({
          type: "observation_recorded",
          payload: { text: "call 415-555-1234 and password=sup3rs3cret" },
          sessionId,
          actor: { name: "alice", type: "human" },
        });
        expect(inserted.payload_json).toContain("[REDACTED:user_phone]");
        expect(inserted.payload_json).toContain("[REDACTED:password]");
        expect(inserted.payload_json).not.toContain("415-555-1234");
        expect(inserted.payload_json).not.toContain("sup3rs3cret");
      }).pipe(Effect.provide(layer)) as Effect.Effect<void, never, never>,
    );
  });

  it("still applies built-ins when user config is empty", async () => {
    const layer = Layer.provideMerge(
      Layer.provideMerge(DbLive(dbPath), EventBusNoop),
      actorDefaultsLayer(ActorDefaultsBuiltIn),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const store = yield* EventStore;
        const sessionId = seed(conn);
        const jwt =
          "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
        const inserted = yield* store.append({
          type: "observation_recorded",
          payload: { text: `bearer ${jwt}` },
          sessionId,
          actor: { name: "alice", type: "human" },
        });
        expect(inserted.payload_json).toContain("[REDACTED:jwt]");
        expect(inserted.payload_json).not.toContain("eyJhbGciOi");
      }).pipe(Effect.provide(layer)) as Effect.Effect<void, never, never>,
    );
  });
});
