/**
 * D-M6-00 — GET /api/events/:id and GET /api/events/:id/raw
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { Effect } from "effect";
import { DbConnection, RawEventStore, SessionService } from "@cognit/db";
import { makeApp, type TestApp } from "./helpers.js";

describe("GET /api/events/:id and /raw (D-M6-00)", () => {
  let app: TestApp;
  const EID = "01HZZZZZZZZZZZZZZZZZZZZZZA";
  const SIBLING = "01HZZZZZZZZZZZZZZZZZZZZZZB";
  const IGNORE = "01HZZZZZZZZZZZZZZZZZZZZZZC";

  beforeAll(async () => {
    app = await makeApp();
    // Seed raw + domain via services
    await app.runtime.runPromise(
      Effect.gen(function* () {
        const svc = yield* SessionService;
        const rawStore = yield* RawEventStore;
        const { handle } = yield* DbConnection;

        // Domain via classify ingest
        const r = yield* svc.ingest({
          projectId: app.projectId,
          lazyCreate: false,
          envelope: {
            version: "1.3.0",
            type: "raw_tool_signal",
            session_id: app.sessionId,
            actor_name: "worker",
            actor_type: "worker",
            id: EID,
            source: { tool: "search_replace", command: "PostToolUse" },
            payload: {
              phase: "post",
              host: "grok",
              tool: "search_replace",
              text: "tool search_replace → /x.ts",
              path: "/x.ts",
              tool_input: {
                file_path: "/x.ts",
                old_string: "a",
                new_string: "b",
              },
            },
          },
        });
        expect(r.event.id).toBe(EID);

        // Sibling domain row with same correlation
        const now = new Date().toISOString();
        const actor = handle.get<{ id: string }>(
          "SELECT id FROM actors WHERE name = ?",
          ["worker"],
        );
        handle.run(
          `INSERT INTO events (
            id, project_id, session_id, actor_id, type, version, payload_json,
            correlation_id, created_at
          ) VALUES (?, ?, ?, ?, 'verification_passed', '1.3.0', '{}', ?, ?)`,
          [SIBLING, app.projectId, app.sessionId, actor!.id, EID, now],
        );

        // Ignore-only raw
        yield* rawStore.append({
          id: IGNORE,
          projectId: app.projectId,
          sessionId: app.sessionId,
          type: "raw_tool_signal",
          version: "1.3.0",
          actorName: "worker",
          actorType: "worker",
          envelope: {
            id: IGNORE,
            type: "raw_tool_signal",
            version: "1.3.0",
            session_id: app.sessionId,
            actor_name: "worker",
            actor_type: "worker",
            payload: { phase: "post", host: "grok", tool: "todo_write", text: "todos" },
          },
          domainEventCount: 0,
        });
      }),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /api/events/:id returns domain event", async () => {
    const res = await app.app.request(`/api/events/${EID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; data: { event: { id: string; type: string } } };
    expect(body.kind).toBe("events.get");
    expect(body.data.event.id).toBe(EID);
    expect(body.data.event.type).not.toBe("raw_tool_signal");
  });

  it("GET /api/events/:id/raw resolves same-id produce", async () => {
    const res = await app.app.request(`/api/events/${EID}/raw`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      kind: string;
      data: {
        raw_event: { id: string; envelope: unknown; type: string };
        domain_event_id: string | null;
      };
    };
    expect(body.kind).toBe("events.raw");
    expect(body.data.raw_event.id).toBe(EID);
    expect(body.data.domain_event_id).toBe(EID);
    expect(typeof body.data.raw_event.envelope).toBe("object");
    expect(body.data.raw_event.envelope).not.toBeTypeOf("string");
  });

  it("GET /api/events/:id/raw resolves sibling correlation", async () => {
    const res = await app.app.request(`/api/events/${SIBLING}/raw`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { raw_event: { id: string }; domain_event_id: string | null };
    };
    expect(body.data.raw_event.id).toBe(EID);
    expect(body.data.domain_event_id).toBe(SIBLING);
  });

  it("GET /api/events/:id/raw ignore-only raw", async () => {
    const res = await app.app.request(`/api/events/${IGNORE}/raw`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { raw_event: { id: string }; domain_event_id: string | null };
    };
    expect(body.data.raw_event.id).toBe(IGNORE);
    expect(body.data.domain_event_id).toBeNull();
  });

  it("GET /api/events/:id 400 non-ULID", async () => {
    const res = await app.app.request(`/api/events/not-a-ulid`);
    expect(res.status).toBe(400);
  });

  it("GET /api/events/:id 404 missing", async () => {
    const res = await app.app.request(`/api/events/01HZZZZZZZZZZZZZZZZZZZZZZ9`);
    expect(res.status).toBe(404);
  });

  it("GET /api/events/stream still registered (not captured by :id)", async () => {
    const res = await app.app.request(`/api/events/stream`, {
      headers: { accept: "text/event-stream" },
    });
    // SSE may be 200 with stream
    expect([200, 404]).toContain(res.status);
    // Must not be treated as ULID get
    if (res.status === 400) {
      throw new Error("stream route incorrectly hit :id validation");
    }
  });

  it("GET /api/events/feed still works", async () => {
    const res = await app.app.request(`/api/events/feed?limit=5`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string };
    expect(body.kind).toBe("events.feed");
  });
});

