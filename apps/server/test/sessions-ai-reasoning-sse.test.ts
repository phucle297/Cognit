/**
 * apps/server/test/sessions-ai-reasoning-sse.test.ts — SSE variant of
 * the AI reasoning tab. Split from `sessions-ai-reasoning.test.ts` so
 * the live-boot infra (`bootServer`) and the read-only assertions
 * (`fetchApp`) don't share state.
 *
 * Cases (mirror the dashboard dedup invariant + the SSE-404 path):
 *   1. GET /api/sessions/:id/ai-reasoning/stream on unknown session
 *      id → 404 not_found (v1 envelope, request_id populated).
 *      Mirrors the GET handler's 404 path. Without this the SSE
 *      handler would open a connection and stay silent — the
 *      dashboard would render the page as loading forever.
 *   2. last_event_id replay on the typed stream: post 3
 *      hypothesis_ranked events; the stream connected with the
 *      cursor of the FIRST event replays only events 2 and 3.
 *      Confirms `?last_event_id=` cursor works on the typed stream
 *      (the dashboard relies on it to dedup post-GET arrivals).
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootServer, parseSseFrames, readUntil, type BootedServer } from "./helpers.js";

describe("GET /api/sessions/:id/ai-reasoning/stream (SSE)", () => {
  let server: BootedServer;
  afterEach(async () => {
    await server?.close();
  });

  it("1. unknown session id returns 404 not_found (v1 envelope)", async () => {
    server = await bootServer();
    // Bootstrapped sessionId is a valid ULID; use a different one.
    const bogus = "01nosuchsessxxxxxxxxxxxxxxxxxx";
    const r = await fetch(`${server.url}/api/sessions/${bogus}/ai-reasoning/stream`);
    expect(r.status).toBe(404);
    expect(r.headers.get("content-type")).toContain("application/json");
    const body = (await r.json()) as {
      kind: string;
      code: string;
      message: string;
      request_id: string;
    };
    expect(body.kind).toBe("api_error");
    expect(body.code).toBe("not_found");
    expect(body.message).toContain(bogus);
    // The middleware stamps a request_id on every response; the SSE
    // 404 path must carry one too so support tickets can quote it.
    expect(typeof body.request_id).toBe("string");
    expect(body.request_id.length).toBeGreaterThan(0);
  });

  it("2. last_event_id cursor replays only events strictly after the cursor", async () => {
    server = await bootServer();
    // Need a hypothesis so the AI reasoning stream can carry rows.
    const hypCreate = await fetch(`${server.url}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: server.sessionId,
        type: "hypothesis_created",
        payload: { title: "H", text: "x" },
        actor: "alice:human",
      }),
    });
    expect(hypCreate.status).toBe(201);
    const hypBody = (await hypCreate.json()) as { data: { event: { id: string } } };
    const hypId = hypBody.data.event.id;

    // Post 3 hypothesis_ranked events in order; collect their ids.
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`${server.url}/api/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session_id: server.sessionId,
          type: "hypothesis_ranked",
          payload: {
            hypothesis_id: hypId,
            score: 0.5 + i * 0.1,
            reasoning: `cursor-${i}`,
            evaluator: "ai-supervisor",
            override_rule_based: true,
            context_event_ids: [],
          },
          actor: "alice:human",
        }),
      });
      expect(r.status).toBe(201);
      const body = (await r.json()) as { data: { event: { id: string } } };
      ids.push(body.data.event.id);
    }
    const cursor = ids[0]!;
    // The dashboard sends the snapshot's highest event id as
    // `?last_event_id=`. The server must replay only events 2 and 3.

    const r = await fetch(
      `${server.url}/api/sessions/${server.sessionId}/ai-reasoning/stream?last_event_id=${encodeURIComponent(cursor)}`,
    );
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    const reader = r.body!.getReader();
    const decoder = new TextDecoder();
    const acc = await readUntil(
      reader,
      decoder,
      (s) => s.includes(`id: ${ids[2]}`),
      3000,
    );
    try { await reader.cancel(); } catch { /* ignore */ }

    const frames = parseSseFrames(acc);
    const seenIds = new Set<string>();
    for (const f of frames) {
      try {
        const parsed = JSON.parse(f.data) as { id: string };
        seenIds.add(parsed.id);
      } catch { /* heartbeat / retry / non-JSON frame */ }
    }
    // Events 2 and 3 MUST be present.
    expect(seenIds.has(ids[1]!)).toBe(true);
    expect(seenIds.has(ids[2]!)).toBe(true);
    // Event 1 (cursor) MUST NOT — it was the cursor.
    expect(seenIds.has(ids[0]!)).toBe(false);
  });
});
