/**
 * apps/server/test/verify-routes.test.ts — 5 cases covering phase 5.6.
 *
 *   1. POST /verify starts (201, state="started").
 *   2. `linked_hypothesis_id` is stored on the started row.
 *   3. POST /verify/:id/cancel transitions the verification to
 *      `cancelled` and the event appears in /sessions/:id/events.
 *   4. POST /verify/:id/cancel on an unknown id returns 404.
 *   5. POST /verify on a closed session returns 409.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Effect } from "effect";
import { DbConnection } from "@cognit/db";
import { makeApp, fetchApp, type TestApp } from "./helpers.js";

describe("cognit server — /verify routes (phase 5.6)", () => {
  let ctx: TestApp;
  beforeEach(async () => {
    ctx = await makeApp();
  });
  afterEach(async () => {
    await ctx.close();
  });

  it("1. POST /verify starts a verification (201, state=started)", async () => {
    const f = fetchApp(ctx.app);
    const r = await f("/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: ctx.sessionId,
        command: "true",
        type: "test",
        actor: { name: "alice", type: "human" },
      }),
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as {
      kind: string;
      data: { id: string; session_id: string; state: string; command: string; type: string };
    };
    expect(body.kind).toBe("verification.started");
    expect(body.data.state).toBe("started");
    expect(body.data.command).toBe("true");
    expect(body.data.type).toBe("test");
    expect(body.data.session_id).toBe(ctx.sessionId);
    expect(body.data.id.length).toBeGreaterThan(10);
  });

  it("2. linked_hypothesis_id is stored on the verification_started row", async () => {
    const f = fetchApp(ctx.app);

    // Insert a hypothesis row directly so the FK on
    // events.linked_hypothesis_id resolves. The event-store does not
    // populate the hypotheses table from hypothesis_created events —
    // the reducer only manages state.hypotheses in memory — so this
    // mirror-insert is the only way to satisfy the FK in tests.
    const hypothesisId = "01hypxxxxxxxxxxxxxxxxxxxx";
    await ctx.runtime.runPromise(
      Effect.gen(function* () {
        const conn = yield* DbConnection;
        conn.handle.run(
          `INSERT INTO hypotheses (id, session_id, title, text, status, created_at)
           VALUES (?, ?, ?, ?, 'active', ?)`,
          [hypothesisId, ctx.sessionId, "H-link", "to link", new Date().toISOString()],
        );
      }) as unknown as Effect.Effect<void, never, never>,
    );

    const r = await f("/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: ctx.sessionId,
        command: "true",
        type: "test",
        linked_hypothesis_id: hypothesisId,
        actor: { name: "alice", type: "human" },
      }),
    });
    expect(r.status).toBe(201);
    const verificationId = ((await r.json()) as { data: { id: string } }).data.id;

    // Re-fetch the events list and find the started row by id.
    const events = await f(`/sessions/${ctx.sessionId}/events?limit=200`);
    const eventsBody = (await events.json()) as {
      data: { events: ReadonlyArray<{ id: string; type: string; linked_hypothesis_id: string | null }> };
    };
    const started = eventsBody.data.events.find(
      (e) => e.id === verificationId && e.type === "verification_started",
    );
    expect(started).toBeDefined();
    expect(started!.linked_hypothesis_id).toBe(hypothesisId);
  });

  it("3. POST /verify/:id/cancel transitions to cancelled and emits the event", async () => {
    const f = fetchApp(ctx.app);
    // Use a long-running command so the subprocess is still alive when
    // we cancel it. `sleep 30` runs in the background via sh -c.
    const r = await f("/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: ctx.sessionId,
        command: "sleep 30",
        type: "exec",
        actor: { name: "alice", type: "human" },
      }),
    });
    expect(r.status).toBe(201);
    const verificationId = ((await r.json()) as { data: { id: string } }).data.id;

    const cancel = await f(`/verify/${verificationId}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: { name: "alice", type: "human" },
        reason: "test cancel",
      }),
    });
    expect(cancel.status).toBe(200);
    const cancelBody = (await cancel.json()) as {
      kind: string;
      data: { id: string; state: string; idempotent: boolean };
    };
    expect(cancelBody.kind).toBe("verification.cancelled");
    expect(cancelBody.data.state).toBe("cancelled");
    expect(cancelBody.data.idempotent).toBe(false);

    // The verification_cancelled event should be visible in the
    // session's event log with parent_verification_id = verificationId.
    const events = await f(`/sessions/${ctx.sessionId}/events?limit=200`);
    const eventsBody = (await events.json()) as {
      data: { events: ReadonlyArray<{ id: string; type: string; parent_verification_id: string | null }> };
    };
    const cancelled = eventsBody.data.events.find(
      (e) => e.type === "verification_cancelled" && e.parent_verification_id === verificationId,
    );
    expect(cancelled).toBeDefined();

    // Idempotency: second cancel returns 200 with idempotent=true.
    const cancel2 = await f(`/verify/${verificationId}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: { name: "alice", type: "human" },
        reason: "test cancel",
      }),
    });
    expect(cancel2.status).toBe(200);
    const cancel2Body = (await cancel2.json()) as {
      data: { state: string; idempotent: boolean };
    };
    expect(cancel2Body.data.state).toBe("cancelled");
    expect(cancel2Body.data.idempotent).toBe(true);
  });

  it("4. POST /verify/:id/cancel on an unknown id returns 404", async () => {
    const f = fetchApp(ctx.app);
    const r = await f("/verify/01nosuchverifxxxxxxxxxxxxx/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: { name: "alice", type: "human" },
      }),
    });
    expect(r.status).toBe(404);
  });

  it("5. POST /verify on a closed session returns 409", async () => {
    const f = fetchApp(ctx.app);
    // Close the bootstrap session.
    const close = await f(`/sessions/${ctx.sessionId}/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: { name: "alice", type: "human" },
      }),
    });
    expect(close.status).toBe(200);

    const r = await f("/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: ctx.sessionId,
        command: "true",
        type: "test",
        actor: { name: "alice", type: "human" },
      }),
    });
    expect(r.status).toBe(409);
  });
});