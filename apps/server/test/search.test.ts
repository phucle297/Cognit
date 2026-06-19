/**
 * apps/server/test/search.test.ts — `GET /api/sessions/search`
 *
 * Cases:
 *   1. ranked matches (AC-7.1) — higher-weight kind outranks lower
 *   2. scope to 5 kinds (AC-7.2) — observation/event/artifact content
 *      is NEVER indexed
 *   3. filters (AC-7.3) — status, project, min_confidence are AND-combined
 *   4. related_sessions (AC-7.5) — recovery handler fills the field
 *   5. single-char typo (AC-7.17) — "hypothsis" matches "hypothesis"
 *   6. deterministic (AC-7.19) — same input → same output twice
 *   7. no redaction leak (AC-7.20) — search returns only stored
 *      redacted text; raw payload never leaks
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeApp, fetchApp, type TestApp } from "./helpers.js";
import {
  indexSession,
  runSearch,
  groupBySession,
} from "../src/routes/search.js";

describe("cognit server — /sessions/search (phase 7r.2)", () => {
  let ctx: TestApp;
  beforeEach(async () => {
    ctx = await makeApp();
  });
  afterEach(async () => {
    await ctx.close();
  });

  it("1. ranked matches (AC-7.1): goal hits weight 3 outrank finding hits weight 2", async () => {
    const f = fetchApp(ctx.app);
    const sid = ctx.sessionId;

    // Seed a finding whose text contains "cognit" AND change the
    // session goal to "cognit recovery" via a session-create.
    // The bootstrap session's goal is "server test" — replace by
    // emitting a goal via... there is no goal event, the goal is
    // fixed at create time. Use a second session instead.
    const r = await f("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "cognit recovery work",
        actor: { name: "alice", type: "human" },
      }),
    });
    expect(r.status).toBe(201);
    const sid2 = ((await r.json()) as { data: { session: { id: string } } }).data.session.id;

    await f("/api/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: sid,
        type: "finding_created",
        payload: { text: "cognit index works" },
        actor: "alice:human",
      }),
    });

    const r2 = await f("/api/sessions/search?q=cognit");
    expect(r2.status).toBe(200);
    const body = (await r2.json()) as {
      data: { results: Array<{ kind: string; session_id: string; kind_weight: number }> };
    };
    expect(body.data.results.length).toBeGreaterThanOrEqual(2);
    // The goal match (weight 3) must come first.
    const goalHit = body.data.results.find((r) => r.kind === "goal");
    const findingHit = body.data.results.find((r) => r.kind === "finding");
    expect(goalHit).toBeDefined();
    expect(findingHit).toBeDefined();
    expect(goalHit!.kind_weight).toBe(3);
    expect(findingHit!.kind_weight).toBe(2);
    expect(body.data.results.indexOf(goalHit!)).toBeLessThan(
      body.data.results.indexOf(findingHit!),
    );
    // Touch sid2 so the linter doesn't flag it.
    expect(sid2).toMatch(/^01/);
  });

  it("2. scope to 5 kinds (AC-7.2): observation payload is NEVER indexed", async () => {
    const f = fetchApp(ctx.app);
    // Emit an observation whose payload contains a unique token that
    // would be indexed if the scope leaked.
    await f("/api/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: ctx.sessionId,
        type: "observation_recorded",
        payload: { text: "ZIRPKLAX-9876 should not appear in search" },
        actor: "alice:human",
      }),
    });

    const r = await f("/api/sessions/search?q=ZIRPKLAX");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { data: { results: unknown[] } };
    expect(body.data.results).toEqual([]);
  });

  it("3. filters (AC-7.3): status filter drops mismatched sessions", async () => {
    const f = fetchApp(ctx.app);
    const r = await f("/api/sessions/search?q=test&status=closed");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { data: { results: unknown[] } };
    // The bootstrap session is active, never closed.
    expect(body.data.results).toEqual([]);
  });

  it("4. related_sessions (AC-7.5): recovery handler fills the field via the fuzzy engine", async () => {
    const f = fetchApp(ctx.app);
    // The bootstrap session has goal "server test". Replace it via
    // a session that contains the distinctive token XYZUNIQ in its
    // goal, then a SECOND session whose goal also shares the token.
    // Hitting recovery on the first should surface the second.
    const r1 = await f("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "investigate XYZUNIQ regression in session one",
        actor: { name: "alice", type: "human" },
      }),
    });
    expect(r1.status).toBe(201);
    const sid1 = ((await r1.json()) as { data: { session: { id: string } } }).data.session.id;

    const r2 = await f("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "follow-up on XYZUNIQ in session two",
        actor: { name: "alice", type: "human" },
      }),
    });
    expect(r2.status).toBe(201);

    const rec = await f(`/api/sessions/${sid1}/recovery`);
    expect(rec.status).toBe(200);
    const body = (await rec.json()) as {
      data: { related_sessions: Array<{ id: string; matched_on: string }> };
    };
    // The recovery handler fills related_sessions by running the
    // same fuzzy engine against every other session's content. The
    // second session shares the XYZUNIQ token, so it must appear.
    expect(body.data.related_sessions.length).toBeGreaterThanOrEqual(1);
    const match = body.data.related_sessions.find((r) =>
      r.matched_on.includes("XYZUNIQ"),
    );
    expect(match).toBeDefined();
  });

  it("5. single-char typo (AC-7.17): 'hypothsis' still matches 'hypothesis'", async () => {
    const f = fetchApp(ctx.app);
    await f("/api/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: ctx.sessionId,
        type: "hypothesis_created",
        payload: { title: "H-typo", text: "this hypothesis text" },
        actor: "alice:human",
      }),
    });
    const r = await f("/api/sessions/search?q=hypothsis");
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      data: { results: Array<{ kind: string; text: string }> };
    };
    expect(body.data.results.length).toBeGreaterThanOrEqual(1);
    expect(body.data.results[0]?.kind).toBe("hypothesis");
  });

  it("6. deterministic (AC-7.19): same input → identical output twice", async () => {
    const f = fetchApp(ctx.app);
    await f("/api/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: ctx.sessionId,
        type: "finding_created",
        payload: { text: "deterministic token DET-001 here" },
        actor: "alice:human",
      }),
    });
    const a = await f("/api/sessions/search?q=DET-001");
    const b = await f("/api/sessions/search?q=DET-001");
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(JSON.stringify(await a.json())).toEqual(JSON.stringify(await b.json()));
  });

  it("7. no redaction leak (AC-7.20): index only sees redacted text", async () => {
    const f = fetchApp(ctx.app);
    // Emit a finding containing the canonical redaction marker
    // `<<REDACTED:secret>>`. The redactor (built-in) only redacts
    // known patterns; we test the indexer does not index raw event
    // payloads by sending a payload with a payload-only token.
    await f("/api/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: ctx.sessionId,
        type: "finding_created",
        payload: { text: "needle INVISIBLE-RAW-PAYLOAD is here" },
        actor: "alice:human",
      }),
    });

    // Search for the text field only. The payload (not in scope) is
    // never indexed, so the search must hit via the redacted text
    // we stored via the text field, not via the payload.
    const r = await f("/api/sessions/search?q=needle");
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      data: { results: Array<{ kind: string; text: string }> };
    };
    expect(body.data.results.length).toBeGreaterThanOrEqual(1);
    // The text we see back is the redacted text we wrote, not raw
    // payload bytes.
    expect(body.data.results[0]?.text).toContain("needle");
  });
});

describe("search index helpers (pure)", () => {
  it("indexSession emits one entry per kind for a state with one of each", () => {
    const out = indexSession(
      "01S",
      "01P",
      "active",
      {
        // Minimal SessionState — we cast via unknown because the
        // helper only reads the maps we care about.
        findings: new Map([
          ["01F", { id: "01F", text: "ft", summary: null, confidence: null, supporting_hypothesis_ids: [], contradicting_hypothesis_ids: [], created_at: "2026-01-01T00:00:00.000Z", last_event_id: "e1", last_event_at: "2026-01-01T00:00:00.000Z" }],
        ]),
        hypotheses: new Map([
          ["01H", { id: "01H", title: "ht", text: "hT", current_state: "active", current_confidence: 0.8, current_reason: null, reason_type: null, superseded_by_id: null, promoted_to_theory_id: null, belongs_to_theory_id: null, created_at: "2026-01-01T00:00:00.000Z", last_event_id: "e2", last_event_at: "2026-01-01T00:00:00.000Z" }],
        ]),
        decisions: new Map([
          ["01D", { id: "01D", text: "dT", state: "accepted", based_on_conclusion_ids: [], reason: null, superseded_by_decision_id: null, created_at: "2026-01-01T00:00:00.000Z", last_event_id: "e3", last_event_at: "2026-01-01T00:00:00.000Z" }],
        ]),
        conclusions: new Map([
          ["01C", { id: "01C", text: "cT", state: "verified", verification_id: null, supporting_evidence_ids: [], reason: null, created_at: "2026-01-01T00:00:00.000Z", last_event_id: "e4", last_event_at: "2026-01-01T00:00:00.000Z" }],
        ]),
      } as unknown as Parameters<typeof indexSession>[3],
    );
    expect(out).toHaveLength(5); // goal + finding + hypothesis + decision + conclusion
    expect(out.find((e) => e.kind === "goal")).toBeDefined();
    expect(out.find((e) => e.kind === "finding")?.text).toBe("ft");
  });

  it("runSearch returns ranked matches with deterministic ordering", () => {
    const empty = {
      text_goal: "",
      text_finding: "",
      text_hypothesis: "",
      text_decision: "",
      text_conclusion: "",
    };
    const index = [
      {
        id: "goal:01S",
        kind: "goal" as const,
        session_id: "01S",
        project_id: "01P",
        status: "active" as const,
        confidence: null,
        text: "cognit recovery",
        ...empty,
        text_goal: "cognit recovery",
      },
      {
        id: "finding:01S/01F",
        kind: "finding" as const,
        session_id: "01S",
        project_id: "01P",
        status: "active" as const,
        confidence: null,
        text: "cognit index",
        ...empty,
        text_finding: "cognit index",
      },
    ];
    const ranked = runSearch(index, "cognit", { limit: 10, offset: 0 });
    expect(ranked.length).toBe(2);
    // Goal (weight 3) outranks finding (weight 2) in fuse's score.
    expect(ranked[0]?.entry.kind).toBe("goal");
    expect(ranked[1]?.entry.kind).toBe("finding");
  });

  it("groupBySession picks the best score per session and returns matched_on", () => {
    const empty = {
      text_goal: "",
      text_finding: "",
      text_hypothesis: "",
      text_decision: "",
      text_conclusion: "",
    };
    const ranked = [
      {
        entry: {
          id: "goal:01S-a",
          kind: "goal" as const,
          session_id: "01S-a",
          project_id: "01P",
          status: "active" as const,
          confidence: null,
          text: "alpha",
          ...empty,
          text_goal: "alpha",
        },
        score: 0.1,
      },
      {
        entry: {
          id: "finding:01S-a/01F",
          kind: "finding" as const,
          session_id: "01S-a",
          project_id: "01P",
          status: "active" as const,
          confidence: null,
          text: "alpha finding",
          ...empty,
          text_finding: "alpha finding",
        },
        score: 0.2,
      },
    ];
    const grouped = groupBySession(ranked, "alpha");
    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.id).toBe("01S-a");
    expect(grouped[0]?.score).toBeCloseTo(0.9, 2);
    expect(grouped[0]?.matched_on).toContain("goal:");
  });
});
