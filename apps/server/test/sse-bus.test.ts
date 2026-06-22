/**
 * apps/server/test/sse-bus.test.ts — SSE replay + live delivery.
 *
 * 5 cases (phase 3 + 5.2 additions):
 *   1. Replay: POST 3 events, then GET /events/stream, assert all 3
 *      arrive in the replay tail (project-wide, default 1000).
 *   2. Live: start a stream consumer, POST a new event, assert the
 *      consumer receives the event within 1s.
 *   3. id-field: every frame carries `id: <row.id>` so a reconnecting
 *      EventSource can resume via Last-Event-ID.
 *   4. Last-Event-ID replay: a stream connecting with the cursor of
 *      the first event receives only events 2 and 3.
 *   5. Heartbeat: a long-lived stream emits `: ping` every 15s
 *      (we shorten to 50ms in test).
 *
 * Why `bootServer` (real socket) and not `app.fetch`: the SSE
 * handler returns a `ReadableStream` body. Reading it through
 * `app.fetch` works in theory, but the timing of `start()`'s fiber
 * is sensitive to Node's microtask scheduler. Using a real socket
 * gives a deterministic TCP-level signal that the test can `await`
 * against.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Effect, Fiber, Layer, ManagedRuntime, Queue } from "effect";
import {
  DbConnection,
  DbLive,
  EventStore,
  Logger,
  LoggerNoop,
  ProjectService,
  SessionPolicyDefault,
  SessionService,
  ConstraintPolicy,
  Uuid,
  UuidLive,
  ActorDefaults,
  ActorDefaultsBuiltIn,
  actorDefaultsLayer,
} from "@cognit/db";
import { EventBus, EventBusLive } from "../src/bus.js";
import { sseHandler, CROCKFORD_ALPHABET_RE, LAST_EVENT_ID_MAX_LEN } from "../src/sse.js";
import type { ServerRuntime } from "../src/routes/sessions.js";
import { bootServer, parseSseFrames, readUntil, type BootedServer } from "./helpers.js";

describe("cognit server — SSE bus", () => {
  let server: BootedServer;
  afterEach(async () => {
    await server?.close();
  });

  it("replays the last 50 events on connect", async () => {
    server = await bootServer();
    // POST 3 events first so the replay has something to emit.
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`${server.url}/api/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session_id: server.sessionId,
          type: "observation_recorded",
          payload: { text: `seed-${i}` },
          actor: "alice:human",
        }),
      });
      expect(r.status).toBe(201);
    }
    // Now connect the stream consumer.
    const r = await fetch(`${server.url}/api/events/stream`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    const reader = r.body!.getReader();
    const decoder = new TextDecoder();
    const acc = await readUntil(
      reader,
      decoder,
      (s) => {
        const frames = parseSseFrames(s);
        // We expect 3+ frames: 1 session_created from bootstrap + 3
        // observations = 4. Be permissive and stop when we have ≥3
        // `data:` frames.
        return frames.length >= 3;
      },
      3000,
    );
    try { await reader.cancel(); } catch { /* ignore */ }
    const frames = parseSseFrames(acc);
    expect(frames.length).toBeGreaterThanOrEqual(3);
    // All frames should be on the default "event" name
    for (const f of frames) {
      expect(f.event).toBe("event");
    }
    // Decode at least one frame's data to confirm shape
    const first = JSON.parse(frames[0]!.data) as { type: string };
    expect(typeof first.type).toBe("string");
  });

  it("delivers a freshly-posted event within 1s of POST", async () => {
    server = await bootServer();
    // Open the stream first so we have a live subscriber.
    const r = await fetch(`${server.url}/api/events/stream`);
    expect(r.status).toBe(200);
    const reader = r.body!.getReader();
    const decoder = new TextDecoder();

    // Post the event
    const unique = `live-${Date.now()}`;
    const post = await fetch(`${server.url}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: server.sessionId,
        type: "observation_recorded",
        payload: { text: unique },
        actor: "alice:human",
      }),
    });
    expect(post.status).toBe(201);

    // Read until we see the unique text in any frame's data.
    const acc = await readUntil(
      reader,
      decoder,
      (s) => s.includes(unique),
      1000,
    );
    try { await reader.cancel(); } catch { /* ignore */ }
    const frames = parseSseFrames(acc);
    const found = frames.some((f) => f.data.includes(unique));
    expect(found).toBe(true);
  });

  // ---- phase 5.2 additions ----

  it("every frame carries an id: line matching the row.id (crash-resilient reconnect)", async () => {
    server = await bootServer();
    // Post a uniquely identifiable event so we can find its frame.
    const marker = `id-marker-${Date.now()}`;
    const post = await fetch(`${server.url}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: server.sessionId,
        type: "observation_recorded",
        payload: { text: marker },
        actor: "alice:human",
      }),
    });
    expect(post.status).toBe(201);
    const posted = (await post.json()) as { data: { event: { id: string; payload_json: string } } };
    // payload_json is the raw JSON string from the row.
    const payload = JSON.parse(posted.data.event.payload_json) as { text: string };
    expect(payload.text).toBe(marker);
    const expectedId = posted.data.event.id;

    // Open the stream; we already have a backlog so the marker is in
    // the replay tail.
    const r = await fetch(`${server.url}/api/events/stream`);
    expect(r.status).toBe(200);
    const reader = r.body!.getReader();
    const decoder = new TextDecoder();
    const acc = await readUntil(
      reader,
      decoder,
      (s) => s.includes(marker),
      3000,
    );
    try { await reader.cancel(); } catch { /* ignore */ }

    // Assert the raw text contains `id: <expectedId>` AND the marker.
    expect(acc).toContain(`id: ${expectedId}`);
    expect(acc).toContain(marker);
  });

  it("honors Last-Event-ID: replay only events strictly after the cursor", async () => {
    server = await bootServer();
    // POST 3 uniquely tagged events in order.
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`${server.url}/api/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session_id: server.sessionId,
          type: "observation_recorded",
          payload: { text: `cursor-${i}` },
          actor: "alice:human",
        }),
      });
      const body = (await r.json()) as { data: { event: { id: string } } };
      ids.push(body.data.event.id);
    }
    const cursor = ids[0]!; // reconnect using the FIRST id as cursor
    // ids[1] and ids[2] should be replayed; ids[0] should NOT.

    const r = await fetch(`${server.url}/api/events/stream`, {
      headers: { "last-event-id": cursor },
    });
    expect(r.status).toBe(200);
    const reader = r.body!.getReader();
    const decoder = new TextDecoder();
    const acc = await readUntil(
      reader,
      decoder,
      (s) => s.includes(`id: ${ids[2]}`),
      3000,
    );
    try { await reader.cancel(); } catch { /* ignore */ }

    // Events 2 and 3 (cursor-1, cursor-2) MUST be present.
    expect(acc).toContain(`id: ${ids[1]}`);
    expect(acc).toContain(`id: ${ids[2]}`);
    // Event 1 (cursor-0) MUST NOT — it was the cursor.
    expect(acc).not.toContain(`id: ${ids[0]}`);
    // No "cursor-0" data line either.
    expect(acc).not.toContain('"text":"cursor-0"');
  });

  it("emits a heartbeat ping every heartbeatMs (shortened to 50ms for the test)", async () => {
    // Build a mini-server with a custom sseHandler (heartbeatMs=50)
    // instead of the production default (15000). Uses the same
    // runtime + bus as the rest of the server stack.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cognit-hb-"));
    const dbPath = path.join(dir, "cognit.db");
    await fs.mkdir(path.join(dir, ".cognit"), { recursive: true });
    await fs.writeFile(path.join(dir, ".cognit", "cognit.yaml"), "version: 1\n");

    const appLayer = Layer.provideMerge(
      DbLive(dbPath, SessionPolicyDefault),
      Layer.mergeAll(EventBusLive, LoggerNoop, UuidLive, actorDefaultsLayer(ActorDefaultsBuiltIn)),
    );
    type Ctx = DbConnection | EventStore | SessionService | ProjectService | ConstraintPolicy | EventBus | Logger | Uuid | ActorDefaults;
    const managed = ManagedRuntime.make(appLayer as Layer.Layer<Ctx, never, never>);
    const projectId = await managed.runPromise(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const id = "01projectxxxxxxxxxxxxxxxxx";
        conn.handle.run(
          `INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)`,
          [id, "test", new Date().toISOString()],
        );
        return id;
      }),
    );
    const sessionId = await managed.runPromise(
      Effect.gen(function* () {
        const svc = yield* SessionService;
        const r = yield* svc.create({ projectId, goal: "hb test", actor: { name: "alice", type: "human" } });
        return r.session.id;
      }),
    );
    const runtime: ServerRuntime = {
      runPromise: <A, E>(eff: Effect.Effect<A, E, never>) =>
        managed.runPromise(eff as unknown as Effect.Effect<A, never, Ctx>) as Promise<A>,
      runPromiseExit: async <A, E>(eff: Effect.Effect<A, E, never>) => {
        const r = await managed.runPromiseExit(eff as unknown as Effect.Effect<A, never, Ctx>);
        return r._tag === "Success"
          ? { _tag: "Success" as const, value: r.value as A }
          : { _tag: "Failure" as const, cause: r.cause };
      },
      runFork: <A, E>(eff: Effect.Effect<A, E, never>) =>
        managed.runFork(eff as unknown as Effect.Effect<A, never, Ctx>) as Fiber.RuntimeFiber<A, E>,
    };
    const app = new Hono();
    app.get("/api/events/stream", sseHandler(runtime, { projectId, heartbeatMs: 50, replayLimit: 5 }));
    const listener = await new Promise<{ url: string; close: () => Promise<void> }>((resolve, reject) => {
      let s: ServerType | null = null;
      s = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info) => {
        resolve({
          url: `http://127.0.0.1:${info.port}`,
          close: async () => {
            s?.close();
            await managed.dispose();
            await fs.rm(dir, { recursive: true, force: true });
          },
        });
      });
      setTimeout(() => reject(new Error("hb test: listen timeout")), 5000).unref();
    });

    try {
      const r = await fetch(`${listener.url}/api/events/stream`);
      expect(r.status).toBe(200);
      const reader = r.body!.getReader();
      const decoder = new TextDecoder();
      // 50ms heartbeat → wait ~300ms, expect ≥2 pings.
      const acc = await readUntil(
        reader,
        decoder,
        (s) => (s.match(/^: ping$/mg) ?? []).length >= 2,
        1000,
      );
      try { await reader.cancel(); } catch { /* ignore */ }
      expect(acc).toMatch(/^: ping$/m);
    } finally {
      await listener.close();
    }
    // Reference unused symbols to satisfy the linter.
    void Queue;
    void sessionId;
  });

  // ---- phase C5 follow-ups ----

  it("emits an `event: error` SSE frame when bus.subscribe() fails (no 200 + empty stream)", async () => {
    // Build a runtime with a REAL EventBusLive — but inject a
    // custom EventBus layer that fails the `subscribe` call so we
    // can exercise the sse.ts catchAllCause handler in a
    // deterministic way. The pure missing-service case was tested
    // out-of-band (see apps/server/src/sse.ts: failing-bus
    // regression covered by the effect runtime itself).
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cognit-sse-err-"));
    const dbPath = path.join(dir, "cognit.db");
    await fs.mkdir(path.join(dir, ".cognit"), { recursive: true });
    await fs.writeFile(path.join(dir, ".cognit", "cognit.yaml"), "version: 1\n");
    // Custom EventBus layer whose subscribe() always rejects.
    const failingBusLayer = Layer.succeed(
      EventBus,
      {
        publish: () => Effect.void,
        subscribe: () => Effect.fail(new Error("synthetic bus failure")),
        shutdown: Effect.void,
      },
    );
    const appLayer = Layer.provideMerge(
      DbLive(dbPath, SessionPolicyDefault),
      Layer.mergeAll(
        failingBusLayer,
        LoggerNoop,
        UuidLive,
        actorDefaultsLayer(ActorDefaultsBuiltIn),
      ),
    );
    type Ctx = DbConnection | EventStore | SessionService | ProjectService | ConstraintPolicy | EventBus | Logger | Uuid | ActorDefaults;
    const managed = ManagedRuntime.make(appLayer as Layer.Layer<Ctx, never, never>);
    const projectId = await managed.runPromise(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        const id = "01projectxxxxxxxxxxxxxxxxx";
        conn.handle.run(
          `INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)`,
          [id, "test", new Date().toISOString()],
        );
        return id;
      }),
    );
    const runtime: ServerRuntime = {
      runPromise: <A, E>(eff: Effect.Effect<A, E, never>) =>
        managed.runPromise(eff as unknown as Effect.Effect<A, never, Ctx>) as Promise<A>,
      runPromiseExit: async <A, E>(eff: Effect.Effect<A, E, never>) => {
        const r = await managed.runPromiseExit(eff as unknown as Effect.Effect<A, never, Ctx>);
        return r._tag === "Success"
          ? { _tag: "Success" as const, value: r.value as A }
          : { _tag: "Failure" as const, cause: r.cause };
      },
      runFork: <A, E>(eff: Effect.Effect<A, E, never>) =>
        managed.runFork(eff as unknown as Effect.Effect<A, never, Ctx>) as Fiber.RuntimeFiber<A, E>,
    };
    const app = new Hono();
    app.get("/api/events/stream", sseHandler(runtime, { projectId, heartbeatMs: 50, replayLimit: 5 }));
    const listener = await new Promise<{ url: string; close: () => Promise<void> }>((resolve, reject) => {
      let s: ServerType | null = null;
      s = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info) => {
        resolve({
          url: `http://127.0.0.1:${info.port}`,
          close: async () => {
            s?.close();
            await managed.dispose();
            await fs.rm(dir, { recursive: true, force: true });
          },
        });
      });
      setTimeout(() => reject(new Error("sse-err: listen timeout")), 5000).unref();
    });
    try {
      const r = await fetch(`${listener.url}/api/events/stream`);
      expect(r.status).toBe(200);
      const reader = r.body!.getReader();
      const decoder = new TextDecoder();
      const acc = await readUntil(
        reader,
        decoder,
        (s) => /event:\s*error/.test(s),
        2000,
      );
      try { await reader.cancel(); } catch { /* ignore */ }
      expect(acc).toMatch(/event:\s*error/);
      expect(acc).toContain(`"kind":"api_error"`);
      expect(acc).toContain(`"code":"internal"`);
      expect(acc).toContain(`"message":"event stream subscribe failed"`);
    } finally {
      await listener.close();
    }
  });

  it("rejects last_event_id longer than 64 chars and non-Crockford before SQL", async () => {
    server = await bootServer();
    const decoder = new TextDecoder();
    // 1) Length cap: 65 'A' chars → must NOT be treated as a cursor.
    //    The replay falls back to the full tail, never throws a
    //    SQL parameter error.
    const tooLong = "A".repeat(LAST_EVENT_ID_MAX_LEN + 1);
    expect(tooLong.length).toBeGreaterThan(LAST_EVENT_ID_MAX_LEN);
    const r1 = await fetch(
      `${server.url}/api/events/stream?last_event_id=${tooLong}`,
    );
    expect(r1.status).toBe(200);
    const reader1 = r1.body!.getReader();
    const acc1 = await readUntil(reader1, decoder, (s) => s.includes("event:"), 1500);
    try { await reader1.cancel(); } catch { /* ignore */ }
    expect(acc1).toMatch(/event:\s*event/);

    // 2) Non-Crockford: contains 'L' which is NOT in the Crockford
    //    base32 alphabet (excludes I, L, O, U).
    const nonCrockford = "01HELLOHELLOHELLOHELLO";
    expect(CROCKFORD_ALPHABET_RE.test(nonCrockford)).toBe(false);
    const r2 = await fetch(
      `${server.url}/api/events/stream?last_event_id=${encodeURIComponent(nonCrockford)}`,
    );
    expect(r2.status).toBe(200);
    const reader2 = r2.body!.getReader();
    const acc2 = await readUntil(reader2, decoder, (s) => s.includes("event:"), 1500);
    try { await reader2.cancel(); } catch { /* ignore */ }
    expect(acc2).toMatch(/event:\s*event/);

    // 3) Crockford-conformant cursor still works (regression check
    //    that the validation didn't accidentally reject everything).
    // Post two markers so the cursor (first id) is NOT the most
    // recent — the second marker should appear in the replay tail.
    const markerA = `capA-${Date.now()}`;
    const markerB = `capB-${Date.now()}`;
    const postA = await fetch(`${server.url}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: server.sessionId,
        type: "observation_recorded",
        payload: { text: markerA },
        actor: "alice:human",
      }),
    });
    expect(postA.status).toBe(201);
    const postedA = (await postA.json()) as { data: { event: { id: string } } };
    const validCursor = postedA.data.event.id;
    const postB = await fetch(`${server.url}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: server.sessionId,
        type: "observation_recorded",
        payload: { text: markerB },
        actor: "alice:human",
      }),
    });
    expect(postB.status).toBe(201);
    expect(CROCKFORD_ALPHABET_RE.test(validCursor)).toBe(true);
    expect(validCursor.length).toBeLessThanOrEqual(LAST_EVENT_ID_MAX_LEN);
    const r3 = await fetch(
      `${server.url}/api/events/stream?last_event_id=${validCursor}`,
    );
    expect(r3.status).toBe(200);
    const reader3 = r3.body!.getReader();
    const acc3 = await readUntil(
      reader3,
      decoder,
      (s) => s.includes(markerB),
      2000,
    );
    try { await reader3.cancel(); } catch { /* ignore */ }
    // MarkerB is strictly after the cursor → it must be replayed.
    expect(acc3).toContain(markerB);
    // MarkerA is the cursor itself → it must NOT be replayed.
    expect(acc3).not.toContain(markerA);
  });
});
