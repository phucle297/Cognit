/**
 * apps/server/src/routes/sessions-gravity.ts — phase 8 (8g.4) + C4 widening.
 *
 * GET /api/sessions/:id/gravity → { ranked: Array<RankedRow> }
 *
 * Read-only handler. Uses:
 *   - SessionService.show         (reduce / replay state)
 *   - GravityQueries.contributingActors  (per-hypothesis actor join)
 *   - GravityQueries.gravityFiredAtForSession  (batch firedAt)
 *   - apps/server/src/gravity-inputs.rankActiveHypothesesFromState
 *
 * Sort: score DESC, id ASC (stable).
 * Endpoint never writes — AC-8.13 "50-call read-only audit" lock.
 * On unknown session id: 404 not_found.
 *
 * Phase C4 widening: each row now also carries `title`, `source`
 * (`"ai"` when the supervisor overrode the rule-based score,
 * `"rule"` otherwise), `ai_score` (the raw override; `null` when
 * rule-based), `rule_score` (the formula's output; `null` when the
 * AI override took precedence), and `delta` (ai - rule; `null`
 * when either side is missing). Original `id` / `text` / `score`
 * fields unchanged so existing clients (e.g. the Decision Graph
 * page) keep working.
 */
import { Effect } from "effect";
import { Hono } from "hono";
import {
  GravityQueries,
  SessionService,
  type SessionRow,
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
import type { SessionsRouteDeps } from "./sessions.js";

export const registerSessionsGravityRoute = (
  app: Hono,
  deps: SessionsRouteDeps,
): void => {
  const { runtime } = deps;

  app.get("/api/sessions/:id/gravity", async (c) => {
    const id = c.req.param("id");
    const program = Effect.gen(function* () {
      const service = yield* SessionService;
      const gravityQ = yield* GravityQueries;
      const show = yield* service.show(id);
      const firedAt = yield* gravityQ.gravityFiredAtForSession(id);
      // Resolve contributingActors for every active hypothesis in
      // state. We do this in the route so the gravity package stays
      // pure (no DB dep). The N-query pattern is bounded by the
      // active hypothesis count — typically O(1)-O(10).
      const actorsByHyp = new Map<string, ReadonlyArray<
        import("@cognit/db").ContributingActor
      >>();
      for (const h of show.state.hypotheses.values()) {
        if (h.current_state !== "active") continue;
        const actors = yield* gravityQ.contributingActors(h.id);
        actorsByHyp.set(h.id, actors);
      }
      return { show, firedAt, actorsByHyp };
    });
    const exit = await runtime.runPromiseExit(
      program as Effect.Effect<unknown, unknown, never>,
    );
    if (exit._tag === "Failure") {
      const cause = (exit as { cause: unknown }).cause;
      const err = JSON.stringify(cause);
      if (err.includes("UnknownSession")) {
        return apiErrorResponse(c, "not_found", `session '${id}' not found`, { id });
      }
      return apiErrorResponse(c, "internal", "session.gravity: query failed");
    }
    const v = (exit as {
      value: {
        show: {
          session: SessionRow;
          state: SessionState;
          snapshot: SnapshotRow | null;
          eventsAfterSnapshot: number;
        };
        firedAt: ReadonlyMap<string, number>;
        actorsByHyp: ReadonlyMap<string, ReadonlyArray<
          import("@cognit/db").ContributingActor
        >>;
      };
    }).value;
    // `nowSec` for freshness — the only non-deterministic input.
    // Tests can stub `Date.now`; the gravity scorer itself is pure.
    const nowSec = Math.floor(Date.now() / 1000);
    const ranked = rankActiveHypothesesFromState(
      v.show.state,
      DEFAULT_GRAVITY_CFG,
      v.actorsByHyp,
      v.firedAt,
      nowSec,
    );
    // Wire shape: id + text + score per AC-8.13 (kept for backwards
    // compatibility with the Decision Graph page and existing
    // clients). Phase C4 widens it with `source`, `title`, and
    // `ai_score` so the AI Reasoning tab can render side-by-side
    // without a second round-trip. Old fields remain authoritative;
    // new fields are additive.
    //
    // `rule_score` is computed for both branches. When
    // `source === "rule"` it equals `score`. When `source === "ai"`
    // the package skipped the formula, so we re-run it here using
    // the same inputs (actors + firedAt) the package would have
    // used. `delta = ai - rule` so the dashboard can colour the
    // movement.
    const halfLife = DEFAULT_GRAVITY_CFG.gravity.freshness_half_life_days;
    const wire = ranked.map((r) => {
      const h = v.show.state.hypotheses.get(r.id);
      const ai = h?.ai_rank_score ?? null;
      const ruleScore = ((): number => {
        if (r.source === "rule") return r.score;
        const actors = v.actorsByHyp.get(r.id) ?? [];
        const fired = v.firedAt.get(r.id) ?? 0;
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
      const delta = ai !== null ? ai - ruleScore : null;
      return {
        id: r.id,
        text: r.text,
        title: r.title,
        score: r.score,
        source: r.source,
        ai_score: ai,
        rule_score: ruleScore,
        delta,
      };
    });
    return c.json(envelope("session.gravity", { ranked: wire }));
  });
};
