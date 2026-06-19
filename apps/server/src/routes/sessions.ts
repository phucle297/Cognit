/**
 * apps/server/src/routes/sessions.ts — sessions routes.
 *
 *   GET  /sessions                      list
 *   GET  /sessions/:id                  row by id
 *   GET  /sessions/:id/state            SessionState view
 *   GET  /sessions/:id/graph            nodes + edges + synthesized verified_by
 *   GET  /sessions/:id/recovery         v0.1: 3 fields only (no v0.2)
 *   POST /sessions                      create (201)
 *   POST /sessions/:id/pause            pause (200 / 404 / 409)
 *   POST /sessions/:id/close            close  (200 / 404 / 409)
 *   POST /sessions/:id/resume           resume (200 / 404 / 409)
 *
 * Mutations funnel through `SessionService` so the redaction boundary,
 * the constraint chokepoint, and the single bus publish (phase 5.1)
 * stay in effect. We never write via a parallel code path.
 *
 * Bodies (hand-rolled validation, no Effect Schema):
 *   POST /sessions                       { goal, parent_session_id?, actor: {name, type} }
 *   POST /sessions/:id/pause             { actor: {name, type} }
 *   POST /sessions/:id/close             { actor: {name, type} }
 *   POST /sessions/:id/resume            { actor: {name, type}, fork_on_resume?: boolean }
 *
 * Errors:
 *   400 validation_failed  — body shape / actor type.
 *   404 not_found          — session id unknown.
 *   409 conflict           — illegal transition (e.g. pause closed).
 *   500 internal           — DbError surface.
 */
import { Effect, Fiber } from "effect";
import { Hono } from "hono";
import {
  SessionService,
  VerificationQueries,
  type SessionRow,
  type SnapshotRow,
} from "@cognit/db";
import type { SessionState } from "@cognit/core/state";
import {
  buildRecovery,
  serialiseLatestVerification,
} from "@cognit/recovery";
import { envelope } from "../envelope.js";
import { apiErrorResponse } from "../api-error.js";
import { registerSessionsMutations } from "./sessions-mutations.js";

/**
 * Tiny runtime facade. The server boot (and tests) build this
 * themselves and pass it in. It wraps `Effect.runPromise` /
 * `Effect.runPromiseExit` with the app layer already provided.
 */
export interface ServerRuntime {
  readonly runPromise: <A, E>(eff: Effect.Effect<A, E, never>) => Promise<A>;
  readonly runPromiseExit: <A, E>(eff: Effect.Effect<A, E, never>) => Promise<{ _tag: "Success"; value: A } | { _tag: "Failure"; cause: unknown }>;
  readonly runFork: <A, E>(eff: Effect.Effect<A, E, never>) => Fiber.RuntimeFiber<A, E>;
}

export interface SessionsRouteDeps {
  readonly runtime: ServerRuntime;
  readonly projectId: string;
}

export interface StateView {
  readonly session: SessionRow;
  readonly state: SessionState;
  readonly snapshot: SnapshotRow | null;
  readonly eventsAfterSnapshot: number;
}

export const registerSessionsRoutes = (app: Hono, deps: SessionsRouteDeps): void => {
  const { runtime, projectId } = deps;

  // GET /sessions
  app.get("/api/sessions", async (c) => {
    const program = Effect.gen(function* () {
      const service = yield* SessionService;
      return yield* service.list({ projectId });
    });
    const sessions = await runtime.runPromise(
      program as Effect.Effect<ReadonlyArray<SessionRow>, never, never>,
    );
    return c.json(envelope("sessions.list", { sessions }));
  });

  // GET /sessions/:id
  app.get("/api/sessions/:id", async (c) => {
    const id = c.req.param("id");
    const program = Effect.gen(function* () {
      const service = yield* SessionService;
      return yield* service.getByGoalOrId({ projectId, id });
    });
    const exit = await runtime.runPromiseExit(
      program as Effect.Effect<unknown, unknown, never>,
    );
    if (exit._tag === "Failure") {
      const cause = (exit as { cause: unknown }).cause;
      const err = JSON.stringify(cause);
      if (err.includes("UnknownGoalOrId")) {
        return apiErrorResponse(c, "not_found", `session '${id}' not found`, { id });
      }
      return apiErrorResponse(c, "internal", "session.get: query failed");
    }
    type R = { readonly session: SessionRow; readonly matches: ReadonlyArray<SessionRow> };
    const v = (exit as { value: R }).value;
    if (!v.session) {
      return apiErrorResponse(c, "not_found", `session '${id}' not found`, { id });
    }
    return c.json(envelope("session.get", { session: v.session, matches: v.matches }));
  });

  // GET /sessions/:id/state
  app.get("/api/sessions/:id/state", async (c) => {
    const id = c.req.param("id");
    const program = Effect.gen(function* () {
      const service = yield* SessionService;
      return yield* service.show(id);
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
      return apiErrorResponse(c, "internal", "session.state: query failed");
    }
    const v = (exit as { value: { session: SessionRow; state: SessionState; snapshot: SnapshotRow | null; eventsAfterSnapshot: number } }).value;
    return c.json(envelope("session.state", v));
  });

  // GET /sessions/:id/graph
  // Returns a deduplicated set of nodes (one per entity) plus the
  // edges currently in state. Each node id is `${entity_type}:${entity_id}`
  // (matches the reducer's edge table convention). For each verified
  // conclusion with a non-null verification_id we synthesize a virtual
  // verified_by edge if one isn't already in state.
  app.get("/api/sessions/:id/graph", async (c) => {
    const id = c.req.param("id");
    const program = Effect.gen(function* () {
      const service = yield* SessionService;
      return yield* service.show(id);
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
      return apiErrorResponse(c, "internal", "session.graph: query failed");
    }
    const v = (exit as {
      value: {
        state: import("@cognit/core/state").SessionState;
      };
    }).value;

    type GraphNode = {
      readonly id: string;
      readonly entity_type: string;
      readonly entity_id: string;
      readonly label: string;
    };
    type GraphEdge = {
      readonly id: string;
      readonly edge_type: string;
      readonly from: string;
      readonly to: string;
      readonly from_entity_type: string;
      readonly from_entity_id: string;
      readonly to_entity_type: string;
      readonly to_entity_id: string;
      readonly virtual: boolean;
    };

    const state = v.state;
    const nodes: GraphNode[] = [];
    const seen = new Set<string>();
    const push = (
      entity_type: string,
      entity_id: string,
      label: string,
    ): void => {
      const key = `${entity_type}:${entity_id}`;
      if (seen.has(key)) return;
      seen.add(key);
      nodes.push({ id: key, entity_type, entity_id, label });
    };

    for (const h of state.hypotheses.values()) push("hypothesis", h.id, h.title);
    for (const d of state.decisions.values()) push("decision", d.id, d.text);
    for (const c2 of state.conclusions.values()) push("conclusion", c2.id, c2.text);
    for (const v2 of state.verifications.values()) push("verification", v2.id, v2.command);
    for (const f of state.findings.values()) push("finding", f.id, f.text);
    for (const o of state.observations.values()) push("observation", o.id, o.text);
    for (const t of state.theories.values()) push("theory", t.id, t.title);
    for (const e of state.experiments.values()) push("experiment", e.id, e.design);

    const edges: GraphEdge[] = state.edges.map((e) => ({
      id: e.id,
      edge_type: e.edge_type,
      from: `${e.from_entity_type}:${e.from_entity_id}`,
      to: `${e.to_entity_type}:${e.to_entity_id}`,
      from_entity_type: e.from_entity_type,
      from_entity_id: e.from_entity_id,
      to_entity_type: e.to_entity_type,
      to_entity_id: e.to_entity_id,
      virtual: false,
    }));

    // Synthesize verified_by for verified conclusions that link to a
    // verification but have no explicit verified_by edge yet.
    const existingVerifiedBy = new Set(
      edges
        .filter((e) => e.edge_type === "verified_by")
        .map((e) => `${e.from_entity_type}:${e.from_entity_id}->${e.to_entity_type}:${e.to_entity_id}`),
    );
    for (const c2 of state.conclusions.values()) {
      if (c2.state !== "verified") continue;
      if (c2.verification_id === null) continue;
      const key = `conclusion:${c2.id}->verification:${c2.verification_id}`;
      if (existingVerifiedBy.has(key)) continue;
      edges.push({
        id: `${c2.id}#verified_by#${c2.verification_id}`,
        edge_type: "verified_by",
        from: `conclusion:${c2.id}`,
        to: `verification:${c2.verification_id}`,
        from_entity_type: "conclusion",
        from_entity_id: c2.id,
        to_entity_type: "verification",
        to_entity_id: c2.verification_id,
        virtual: true,
      });
      push("conclusion", c2.id, c2.text);
      push("verification", c2.verification_id, c2.verification_id);
    }

    return c.json(
      envelope("session.graph", { session_id: id, nodes, edges }),
    );
  });

  // GET /sessions/:id/recovery — v0.2 surface (8 top-level fields).
  //
  // Shape:
  //   - session_id
  //   - related_sessions         (placeholder: [] — phase 7r.2 fills)
  //   - verified_conclusions     (with verification_id)
  //   - rejected_hypotheses      (with reason_type + reason from reducer)
  //   - accepted_decisions       (with based_on)
  //   - rejected_decisions       (with reason)
  //   - latest_verification      (per hypothesis; map of summary)
  //   - last_known_state         (snapshot.state_json if present, else
  //                               freshly-reduced state)
  //   - suggested_next_steps     (placeholder: [] — phase 8 fills)
  //
  // Read-only (AC-7.18): this handler never mutates the DB or the
  // bus. The `read-only: 50 calls no mutation` invariant is upheld
  // by the route calling only `SessionService.show` and the new
  // `VerificationQueries.latestVerificationsForSession`.
  app.get("/api/sessions/:id/recovery", async (c) => {
    const id = c.req.param("id");
    const program = Effect.gen(function* () {
      const service = yield* SessionService;
      const queries = yield* VerificationQueries;
      const show = yield* service.show(id);
      const latestVerifications = yield* queries.latestVerificationsForSession(id);
      return { show, latestVerifications };
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
      return apiErrorResponse(c, "internal", "session.recovery: query failed");
    }
    const v = (exit as {
      value: {
        show: {
          state: import("@cognit/core/state").SessionState;
          snapshot: SnapshotRow | null;
        };
        latestVerifications: ReadonlyMap<
          string,
          import("@cognit/db").LatestVerificationSummary
        >;
      };
    }).value;

    // Parse snapshot.state_json if present. The reducer's
    // rehydrateSessionState is not exported — instead, fall back to
    // the freshly-reduced state when no snapshot exists. When a
    // snapshot exists but its JSON shape is unrecognised, we use the
    // freshly-reduced state too (better than an error envelope).
    const state = v.show.state;
    let snapshotState: import("@cognit/core/state").SessionState | null =
      null;
    if (v.show.snapshot) {
      try {
        snapshotState = state; // the snapshot path produced `state`
        // already via SessionService.show — no separate rehydrate
        // needed; `state` IS the snapshot+tail merge.
      } catch {
        snapshotState = null;
      }
    }

    const recovery = buildRecovery({
      sessionId: id,
      state,
      snapshotState,
      latestVerifications: v.latestVerifications,
    });

    return c.json(
      envelope("session.recovery", {
        ...recovery,
        latest_verification: serialiseLatestVerification(
          recovery.latest_verification,
        ),
      }),
    );
  });

  // Mutations (POST /sessions, pause, close, resume) live in a
  // sibling module to keep this file readable. Both modules share
  // the same Hono app — `app.route` accumulates handlers.
  registerSessionsMutations(app, deps);
};