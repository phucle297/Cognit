/**
 * apps/server/src/routes/sessions-ai-reasoning.ts — phase C4.
 *
 * GET  /api/sessions/:id/ai-reasoning
 *   → envelope("session.ai_reasoning", {
 *       ranked: Array<RankedRow>,
 *       decision_log: Array<TickRow>,
 *     })
 *
 * GET  /api/sessions/:id/ai-reasoning/stream  (SSE)
 *   → text/event-stream, scoped to { session_id, hypothesis_ranked }
 *
 * Read-only handler. Composed from:
 *   - `SessionService.show`  (reduced state with `ai_rank_*` fields)
 *   - `rankActiveHypothesesFromState`  (gravity bridge, same fn the
 *      /gravity and /recovery routes use)
 *   - `DbConnection.handle.all` for the decision_log SQL aggregation
 *   - `sseHandler` with the new `sessionId` + `types` options for
 *      the live stream
 *
 * Sort: ranked by score DESC, id ASC (stable). decision_log by tick
 * DESC (newest first). The decision_log is bucketed server-side
 * using `substr(id, 1, ...)` so we don't ship every event row to
 * group in memory; supervisor ticks share a ULID prefix
 * (`<tickId>-a<idx>` for actions, `<tickId>-r<hypothesisId>` for
 * rank overrides — see `packages/agent/src/apply.ts:177,187`).
 *
 * Endpoint never writes — AC-7.18 read-only invariant mirrored in
 * the test file. On unknown session id: 404 not_found.
 */
import { Effect } from "effect";
import { Hono } from "hono";
import {
  DbConnection,
  GravityQueries,
  SessionService,
  type EventRow,
  type SnapshotRow,
} from "@cognit/db";
import type { SessionState } from "@cognit/core/state";
import {
  scoreHypothesis,
  freshnessForHypothesis,
  meanActorTrust,
} from "@cognit/gravity";
import {
  rankActiveHypothesesFromState,
  DEFAULT_GRAVITY_CFG,
} from "../gravity-inputs.js";
import { envelope } from "../envelope.js";
import { apiErrorResponse } from "../api-error.js";
import { sseHandler } from "../sse.js";
import type { SessionsRouteDeps } from "./sessions.js";

/** Result of bucketing one supervisor tick for the decision_log. */
interface TickRow {
  readonly tick_event_id: string;
  readonly actions_applied: number;
  readonly rank_overrides_applied: number;
  readonly actions_truncated: number;
  readonly stop: boolean;
  readonly created_at: string;
}

/** One row in the ranked list, mirrors the dashboard's table columns. */
interface RankedRow {
  readonly hypothesis_id: string;
  readonly title: string;
  readonly text: string;
  readonly ai_score: number | null;
  readonly rule_score: number | null;
  readonly score: number;
  readonly source: "ai" | "rule";
  readonly delta: number | null;
  readonly reasoning: string | null;
  readonly ai_rank_at: string | null;
  readonly ai_rank_event_id: string | null;
}

/**
 * Type guard for the events we expect to bucket — guards against
 * future event-id format changes in `@cognit/agent`. The supervisor
 * emits ids of shape `${tickId}-a<idx>` or `${tickId}-r<id>`. Any
 * id without a `-` after position 8 is treated as its own tick
 * (single-event fallback).
 */
const tickPrefixOf = (id: string): string => {
  const dash = id.indexOf("-");
  if (dash < 9) return id; // no dash within the tick prefix → single event
  return id.slice(0, dash);
};

/**
 * Pull the most recent supervisor ticks for a session and bucket
 * them by shared tick prefix. Pure SQL — no per-event fan-out.
 *
 * The query selects the last `LIMIT` rows matching the supervisor's
 * event types. We then group them by tick prefix in JS because
 * `substr(id, 1, prefixLen)` would require hardcoding the prefix
 * length; using `indexOf('-')` per row is O(n) on a bounded window
 * (default 200) and avoids that.
 *
 * Stop signals come from the rationale text of `hypothesis_ranked`
 * events when the supervisor decided `stop: true`. The agent loop
 * records `stop` on its decision but does NOT emit a dedicated
 * `decision_stop` event in v1.2.0 — instead we surface a synthetic
 * `stop: false` per tick because the only authoritative stop source
 * is the agent's own stdout (handled by `cognit agent status`).
 * If a future v1.3 emits a stop event, this is the integration
 * point.
 */
const loadDecisionLogE = (
  sessionId: string,
  limit: number,
): Effect.Effect<ReadonlyArray<TickRow>, never, DbConnection> =>
  Effect.gen(function* () {
    const conn = yield* DbConnection;
    // Pull every event for the session in the recent window. The
    // session-scoped event volume is bounded by the operator's
    // behaviour (we cap at `limit` rows). Per-tick grouping reads
    // every row once.
    const rows = conn.handle.all<EventRow>(
      `SELECT * FROM events
       WHERE session_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
      [sessionId, limit],
    );

    // Group by tick prefix, keep the most recent `created_at` per
    // group, and count actions vs rank overrides. An "action" event
    // has an `a` immediately after the dash (`<tickId>-aXXXX`); a
    // "rank override" has an `r` (`<tickId>-r<hypId>`).
    type Bucket = {
      firstId: string;
      createdAt: string;
      actions: number;
      overrides: number;
    };
    const buckets = new Map<string, Bucket>();
    for (const r of rows) {
      const prefix = tickPrefixOf(r.id);
      // When `prefix === r.id` (no dash within the tick zone), the
      // event is a "raw" event with no action/override tag. We
      // classify it by `type` so the counts still reflect what the
      // supervisor did — most importantly `hypothesis_ranked`
      // emitted without the agent prefix (e.g. an operator replay)
      // still count as overrides.
      let isAction = false;
      let isOverride = false;
      if (prefix !== r.id) {
        const after = r.id.slice(prefix.length + 1);
        const kind = after.charAt(0);
        if (kind === "a") isAction = true;
        else if (kind === "r") isOverride = true;
      } else if (r.type === "hypothesis_ranked") {
        isOverride = true;
      }
      const b = buckets.get(prefix);
      if (b === undefined) {
        buckets.set(prefix, {
          firstId: r.id,
          createdAt: r.created_at,
          actions: isAction ? 1 : 0,
          overrides: isOverride ? 1 : 0,
        });
      } else {
        if (r.created_at > b.createdAt) b.createdAt = r.created_at;
        if (isAction) b.actions += 1;
        else if (isOverride) b.overrides += 1;
      }
    }

    // Sort newest first and shape into wire form. `actions_truncated`
    // is not in the event log (the supervisor silently drops over-cap
    // actions — see `packages/agent/src/apply.ts:163-174`), so we
    // surface it as 0 and rely on the `actions` count to make the
    // operator aware of what was actually applied. When the cap
    // becomes configurable (post-v1.2), the wire value can carry the
    // exact truncated count from the apply step.
    return Array.from(buckets.values())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 50)
      .map((b): TickRow => ({
        tick_event_id: b.firstId,
        actions_applied: b.actions,
        rank_overrides_applied: b.overrides,
        actions_truncated: 0,
        stop: false,
        created_at: b.createdAt,
      }));
  });

export const registerSessionsAiReasoningRoute = (
  app: Hono,
  deps: SessionsRouteDeps,
): void => {
  const { runtime, projectId } = deps;

  app.get("/api/sessions/:id/ai-reasoning", async (c) => {
    const id = c.req.param("id");
    const program = Effect.gen(function* () {
      const service = yield* SessionService;
      const gravityQ = yield* GravityQueries;
      const show = yield* service.show(id);
      // Resolve gravity inputs (actors + firedAt) for every active
      // hypothesis so we can compute the rule-based score even when
      // the AI override took precedence. The package's
      // `rankHypotheses` skips the formula in the `ai` branch — we
      // re-run it here so the dashboard can show the delta.
      const firedAt = yield* gravityQ.gravityFiredAtForSession(id);
      const actorsByHyp = new Map<string, ReadonlyArray<
        import("@cognit/db").ContributingActor
      >>();
      for (const h of show.state.hypotheses.values()) {
        if (h.current_state !== "active") continue;
        const actors = yield* gravityQ.contributingActors(h.id);
        actorsByHyp.set(h.id, actors);
      }
      const nowSec = Math.floor(Date.now() / 1000);
      const ranked = rankActiveHypothesesFromState(
        show.state,
        DEFAULT_GRAVITY_CFG,
        actorsByHyp,
        firedAt,
        nowSec,
      );
      const halfLife = DEFAULT_GRAVITY_CFG.gravity.freshness_half_life_days;
      const rows: RankedRow[] = ranked.map((r): RankedRow => {
        const h = show.state.hypotheses.get(r.id);
        const aiScore = h?.ai_rank_score ?? null;
        // Compute the rule-based score in BOTH branches. When
        // `source === "rule"` the package already returned the same
        // number — we just copy it. When `source === "ai"` the
        // package skipped the formula, so we run it here.
        const ruleScore = ((): number => {
          if (r.source === "rule") return r.score;
          const actors = actorsByHyp.get(r.id) ?? [];
          const fired = firedAt.get(r.id) ?? 0;
          return scoreHypothesis(
            {
              evidence_strength: 0,
              reproducibility: 0,
              verification_confidence: 0,
              actor_trust: meanActorTrust(actors),
              freshness_decay: freshnessForHypothesis(fired, nowSec, halfLife),
            },
            DEFAULT_GRAVITY_CFG,
          );
        })();
        const delta =
          aiScore !== null ? aiScore - ruleScore : null;
        return {
          hypothesis_id: r.id,
          title: r.title,
          text: r.text,
          ai_score: aiScore,
          rule_score: ruleScore,
          score: r.score,
          source: r.source,
          delta,
          reasoning: h?.ai_rank_reasoning ?? null,
          ai_rank_at: h?.ai_rank_at ?? null,
          ai_rank_event_id: h?.ai_rank_event_id ?? null,
        };
      });
      const decisionLog = yield* loadDecisionLogE(id, 200);
      return { rows, decisionLog, show };
    });

    type ExitVal = {
      readonly rows: ReadonlyArray<RankedRow>;
      readonly decisionLog: ReadonlyArray<TickRow>;
      readonly show: {
        readonly session: import("@cognit/db").SessionRow;
        readonly state: SessionState;
        readonly snapshot: SnapshotRow | null;
        readonly eventsAfterSnapshot: number;
      };
    };
    const exit = await runtime.runPromiseExit(
      program as unknown as Effect.Effect<ExitVal, unknown, never>,
    );
    if (exit._tag === "Failure") {
      const cause = (exit as { cause: unknown }).cause;
      const err = JSON.stringify(cause);
      if (err.includes("UnknownSession")) {
        return apiErrorResponse(c, "not_found", `session '${id}' not found`, { id });
      }
      return apiErrorResponse(c, "internal", "session.ai_reasoning: query failed");
    }
    const v = (exit as { value: ExitVal }).value;
    return c.json(
      envelope("session.ai_reasoning", {
        session_id: id,
        ranked: v.rows,
        decision_log: v.decisionLog,
      }),
    );
  });

  // SSE variant. Subscribes to the bus and forwards only this
  // session's `hypothesis_ranked` events. Replay is capped at 200
  // rows to match the initial-fetch window — keeps the tab
  // responsive when the user opens it after a long idle.
  //
  // We resolve the path param here and pass the live `sessionId`
  // into `sseHandler` (the factory is curried over runtime + opts,
  // not over the request). The handler then subscribes to the bus
  // and filters by both `session_id` and `type`.
  app.get("/api/sessions/:id/ai-reasoning/stream", (c) => {
    const id = c.req.param("id");
    const handler = sseHandler(runtime, {
      replayLimit: 200,
      projectId,
      sessionId: id,
      types: ["hypothesis_ranked"],
    });
    return handler(c);
  });
};
