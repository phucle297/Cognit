/**
 * apps/server/test/recovery-actions.test.ts — phase 7r.5.
 *
 * Three POST endpoints used by the dashboard's Recovery Center page:
 *
 *   POST /api/sessions/:id/dry-run   — read-only diff
 *   POST /api/sessions/:id/snapshot  — force a fresh snapshots row
 *   POST /api/sessions/:id/export    — full SessionState + markdown
 *
 * 4 cases (3 happy + 1 404):
 *
 *   1. dry-run returns 200 + envelope, AND no new events are written
 *      to /api/sessions/:id/events as a side effect (AC-7.18).
 *   2. snapshot returns 200 + envelope, AND two consecutive calls
 *      produce distinct snapshot_ids (each call lands a new row).
 *   3. export returns 200 + envelope with the SessionState serialised
 *      and a markdown summary.
 *   4. Unknown session id returns a 404 api_error envelope on the
 *      snapshot endpoint.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeApp, fetchApp, type TestApp } from "./helpers.js";

describe("cognit server — recovery actions (phase 7r.5)", () => {
  let ctx: TestApp;
  beforeEach(async () => {
    ctx = await makeApp();
  });
  afterEach(async () => {
    await ctx.close();
  });

  it("1. POST /api/sessions/:id/dry-run returns 200 + envelope and writes nothing", async () => {
    const f = fetchApp(ctx.app);
    const sid = ctx.sessionId;

    // Baseline: how many events are currently in the log? Bootstrap
    // creates a single session_created row, so this is 1 on a fresh
    // session. We snapshot it before the dry-run so we can assert the
    // log size is unchanged afterwards.
    const before = await f(`/api/sessions/${sid}/events`);
    expect(before.status).toBe(200);
    const beforeBody = (await before.json()) as {
      data: { events: ReadonlyArray<unknown> };
    };
    const beforeCount = beforeBody.data.events.length;

    const r = await f(`/api/sessions/${sid}/dry-run`, { method: "POST" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      kind: string;
      data: {
        session_id: string;
        would_reduce_events: number;
        would_reach_state: {
          findings_count: number;
          hypotheses_count: number;
          decisions_count: number;
          conclusions_count: number;
        };
        last_known_event_id: string | null;
      };
    };
    expect(body.kind).toBe("session.dry_run");
    expect(body.data.session_id).toBe(sid);
    // The reducer fold would replay exactly the events in the log.
    expect(body.data.would_reduce_events).toBe(beforeCount);
    expect(body.data.would_reach_state.findings_count).toBe(0);
    expect(body.data.would_reach_state.hypotheses_count).toBe(0);
    expect(body.data.would_reach_state.decisions_count).toBe(0);
    expect(body.data.would_reach_state.conclusions_count).toBe(0);

    // AC-7.18: dry-run must not mutate the event log. Re-fetch and
    // assert the count is unchanged AND the last event id is the
    // same id we recorded in the baseline (i.e. we did not append
    // a dry_run event).
    const after = await f(`/api/sessions/${sid}/events`);
    expect(after.status).toBe(200);
    const afterBody = (await after.json()) as {
      data: { events: ReadonlyArray<{ id: string }> };
    };
    expect(afterBody.data.events.length).toBe(beforeCount);
    if (beforeCount > 0 && afterBody.data.events.length > 0) {
      const firstBefore = (beforeBody.data.events[0] as { id: string }).id;
      const firstAfter = afterBody.data.events[0]!.id;
      expect(firstAfter).toBe(firstBefore);
    }
  });

  it("2. POST /api/sessions/:id/snapshot returns 200 + envelope; consecutive calls differ", async () => {
    const f = fetchApp(ctx.app);
    const sid = ctx.sessionId;

    const r1 = await f(`/api/sessions/${sid}/snapshot`, { method: "POST" });
    expect(r1.status).toBe(200);
    const body1 = (await r1.json()) as {
      kind: string;
      data: {
        snapshot_id: string;
        session_id: string;
        event_id: string;
        event_count: number;
      };
    };
    expect(body1.kind).toBe("session.snapshot");
    expect(typeof body1.data.snapshot_id).toBe("string");
    expect(body1.data.snapshot_id.length).toBeGreaterThan(0);
    expect(body1.data.session_id).toBe(sid);
    expect(body1.data.event_id.length).toBeGreaterThan(0);
    // Bootstrap emits session_created, so at least 1 event.
    expect(body1.data.event_count).toBeGreaterThanOrEqual(1);

    // A second call must land a NEW snapshot row (force snapshot).
    const r2 = await f(`/api/sessions/${sid}/snapshot`, { method: "POST" });
    expect(r2.status).toBe(200);
    const body2 = (await r2.json()) as {
      data: { snapshot_id: string; event_count: number };
    };
    expect(body2.data.snapshot_id).not.toBe(body1.data.snapshot_id);
    // Same event log → same event_count.
    expect(body2.data.event_count).toBe(body1.data.event_count);
  });

  it("3. POST /api/sessions/:id/export returns 200 + envelope with state + markdown", async () => {
    const f = fetchApp(ctx.app);
    const sid = ctx.sessionId;

    const r = await f(`/api/sessions/${sid}/export`, { method: "POST" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      kind: string;
      data: {
        session_id: string;
        goal: string;
        status: string;
        state: Record<string, unknown>;
        markdown: string;
      };
    };
    expect(body.kind).toBe("session.export");
    expect(body.data.session_id).toBe(sid);
    expect(typeof body.data.goal).toBe("string");
    expect(typeof body.data.status).toBe("string");

    // The serialised state must be a JSON-safe object — Maps
    // converted to plain objects (e.g. `hypotheses: {}`).
    expect(typeof body.data.state).toBe("object");
    expect(body.data.state).not.toBeNull();
    const stateObj = body.data.state;
    // State top-level keys, post-sort.
    expect(Object.keys(stateObj).sort()).toContain("goal");
    expect(Object.keys(stateObj).sort()).toContain("status");
    expect(Object.keys(stateObj).sort()).toContain("hypotheses");
    // Hypotheses was a Map → must now be an object (empty for a
    // freshly-bootstrapped session with only session_created).
    expect(stateObj.hypotheses).toEqual({});

    // Markdown summary: a heading plus the three recovery sections
    // with zero counts (no rejected hypotheses / verified conclusions
    // / accepted decisions on a fresh session).
    expect(typeof body.data.markdown).toBe("string");
    expect(body.data.markdown).toContain("# Recovery summary");
    expect(body.data.markdown).toContain("Rejected hypotheses (0)");
    expect(body.data.markdown).toContain("Verified conclusions (0)");
    expect(body.data.markdown).toContain("Accepted decisions (0)");
  });

  it("4. POST /api/sessions/:id/snapshot on an unknown id returns 404 api_error", async () => {
    const f = fetchApp(ctx.app);
    const r = await f("/api/sessions/01nosuchsessxxxxxxxxxxx/snapshot", {
      method: "POST",
    });
    expect(r.status).toBe(404);
    const body = (await r.json()) as {
      kind: string;
      code: string;
      message: string;
      request_id: string;
    };
    expect(body.kind).toBe("api_error");
    expect(body.code).toBe("not_found");
    expect(body.message).toContain("01nosuchsessxxxxxxxxxxx");
    expect(typeof body.request_id).toBe("string");
  });
});
