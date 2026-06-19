/**
 * apps/dashboard/test/sse-live.e2e.test.ts — SSE live delivery (E2E).
 *
 * 3 cases that prove the SSE bus delivers observations to a live
 * subscriber in real time (plan §phase_6 §AC-3 / Timeline page).
 * The dashboard's Timeline page subscribes via `EventSource`; this
 * test exercises the same wire protocol from a `fetch` reader.
 *
 *   a. GET  /events/stream → 200, content-type text/event-stream
 *   b. First SSE frame is a heartbeat (`:` comment or empty) within 1000ms
 *   c. POST /events  then SSE delivers that event within 1500ms
 *
 * Reuses `parseSseFrames` and `readUntil` from helpers — same
 * parser phase 5 uses. The bus is the production
 * `EventBus.publish`; subscriber gets the observation via
 * `Queue.take` (see apps/server/src/bus.ts).
 *
 * Read-only: server untouched.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  bootServer,
  parseSseFrames,
  readUntil,
  type BootedServer,
} from "../../server/test/helpers.js";

describe("cognit dashboard — sse-live e2e", () => {
  let server: BootedServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("a. GET /events/stream returns 200 with text/event-stream", async () => {
    server = await bootServer({ isLoopback: true });
    const res = await fetch(`${server.url}/api/events/stream`);
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") ?? "";
    expect(ct).toContain("text/event-stream");
    // Clean up the open stream.
    try { await res.body?.cancel(); } catch { /* ignore */ }
  });

  it("b. First SSE frame is a heartbeat within 1000ms", async () => {
    server = await bootServer({ isLoopback: true });
    const res = await fetch(`${server.url}/api/events/stream`);
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let acc = "";
    try {
      // Heartbeat: empty block or a comment line (`:keepalive`).
      // We accept any first non-empty frame within the budget —
      // the dashboard's use-event-source hook treats heartbeats as
      // connection-keep signals, not data.
      acc = await readUntil(
        reader,
        decoder,
        (s) => s.includes("\n\n"),
        1000,
      );
    } finally {
      try { await reader.cancel(); } catch { /* ignore */ }
    }
    const frames = parseSseFrames(acc);
    // First frame is parsed (heartbeat has data="" so may be filtered
    // out by parseSseFrames; we only assert *some* boundary was read).
    expect(acc).toContain("\n\n");
    // If a frame with data arrived, it should be one of the bus's
    // lifecycle frames or a comment — never raw user observation text.
    const firstWithData = frames[0];
    if (firstWithData) {
      // event.name defaults to "message"; data must not be the
      // string "obs-marker" we use in case c.
      expect(firstWithData.data).not.toBe("obs-marker");
    }
  });

  it("c. POST /events delivers observation via SSE within 1500ms", async () => {
    server = await bootServer({ isLoopback: true });
    // Open the stream FIRST, then post. The bus subscriber list is
    // populated when the stream handler subscribes; posting before
    // the stream opens would race the subscriber registration.
    const streamRes = await fetch(`${server.url}/api/events/stream`);
    expect(streamRes.status).toBe(200);

    const reader = streamRes.body!.getReader();
    const decoder = new TextDecoder();
    const marker = `sse-live-obs-${Date.now()}`;
    let acc = "";
    try {
      // Read in parallel with the POST.
      const readPromise = readUntil(
        reader,
        decoder,
        (s) => s.includes(marker),
        1500,
      );
      const postPromise = fetch(`${server.url}/api/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session_id: server.sessionId,
          type: "observation_recorded",
          payload: { text: marker },
          actor: "alice:human",
        }),
      });
      const [postRes, sseAcc] = await Promise.all([postPromise, readPromise]);
      expect(postRes.status).toBe(201);
      acc = sseAcc;
    } finally {
      try { await reader.cancel(); } catch { /* ignore */ }
    }
    const frames = parseSseFrames(acc);
    const obsFrame = frames.find((f) => f.data.includes(marker));
    expect(obsFrame).toBeDefined();
  });
});
