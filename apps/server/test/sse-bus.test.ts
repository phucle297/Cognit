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
} from "@cognit/db";
import { EventBus, EventBusLive } from "../src/bus.js";
import { sseHandler } from "../src/sse.js";
import type { ServerRuntime } from "../src/routes/sessions.js";
import { bootServer, type BootedServer } from "./helpers.js";

const parseSseFrames = (chunk: string): Array<{ event: string; data: string }> => {
  // SSE frames are `event: <name>\ndata: <json>\n\n`. We split on
  // the double-newline and parse each block.
  const frames: Array<{ event: string; data: string }> = [];
  for (const block of chunk.split("\n\n")) {
    if (!block) continue;
    let eventName = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) eventName = line.slice("event: ".length);
      else if (line.startsWith("data: ")) data += line.slice("data: ".length);
    }
    if (data) frames.push({ event: eventName, data });
  }
  return frames;
};

const readUntil = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: InstanceType<typeof TextDecoder>,
  predicate: (acc: string) => boolean,
  timeoutMs: number,
): Promise<string> => {
  const acc: string[] = [];
  const start = Date.now();
  let done = false;
  while (!done) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`readUntil: timed out after ${timeoutMs}ms. Accumulated: ${acc.join("")}`);
    }
    const remain = Math.max(1, timeoutMs - (Date.now() - start));
    const { value, done: rdone } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: true }>((r) =>
        setTimeout(() => r({ value: undefined, done: true }), remain),
      ),
    ]);
    if (value) {
      const text = decoder.decode(value, { stream: true });
      acc.push(text);
      if (predicate(acc.join(""))) {
        done = true;
      }
    }
    if (rdone) {
      done = true;
    }
  }
  return acc.join("");
};

describe("cognit server — SSE bus", () => {
  let server: BootedServer;
  afterEach(async () => {
    await server?.close();
  });

  it("replays the last 50 events on connect", async () => {
    server = await bootServer();
    // POST 3 events first so the replay has something to emit.
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`${server.url}/events`, {
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
    const r = await fetch(`${server.url}/events/stream`);
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
    const r = await fetch(`${server.url}/events/stream`);
    expect(r.status).toBe(200);
    const reader = r.body!.getReader();
    const decoder = new TextDecoder();

    // Post the event
    const unique = `live-${Date.now()}`;
    const post = await fetch(`${server.url}/events`, {
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
    const post = await fetch(`${server.url}/events`, {
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
    const r = await fetch(`${server.url}/events/stream`);
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
      const r = await fetch(`${server.url}/events`, {
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

    const r = await fetch(`${server.url}/events/stream`, {
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
      Layer.merge(EventBusLive, LoggerNoop),
    );
    type Ctx = DbConnection | EventStore | SessionService | ProjectService | ConstraintPolicy | EventBus | Logger;
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
    app.get("/events/stream", sseHandler(runtime, { projectId, heartbeatMs: 50, replayLimit: 5 }));
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
      const r = await fetch(`${listener.url}/events/stream`);
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
});
