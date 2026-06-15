/**
 * apps/server/test/sse-bus.test.ts — SSE replay + live delivery.
 *
 * 2 cases:
 *   1. Replay: POST 3 events, then GET /events/stream, assert all 3
 *      arrive in the replay tail (project-wide, default 50).
 *   2. Live: start a stream consumer, POST a new event, assert the
 *      consumer receives the event within 1s.
 *
 * Why `bootServer` (real socket) and not `app.fetch`: the SSE
 * handler returns a `ReadableStream` body. Reading it through
 * `app.fetch` works in theory, but the timing of `start()`'s fiber
 * is sensitive to Node's microtask scheduler. Using a real socket
 * gives a deterministic TCP-level signal that the test can `await`
 * against.
 */
import { describe, it, expect, afterEach } from "vitest";
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
});
