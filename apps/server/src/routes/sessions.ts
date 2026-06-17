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
  type SessionRow,
  type SnapshotRow,
} from "@cognit/db";
import type { SessionState } from "@cognit/core/state";
import { envelope } from "../envelope.js";
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
  app.get("/sessions", async (c) => {
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
  app.get("/sessions/:id", async (c) => {
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
        return c.json({ error: "not_found", id }, 404);
      }
      return c.json({ error: "internal", cause }, 500);
    }
    type R = { readonly session: SessionRow; readonly matches: ReadonlyArray<SessionRow> };
    const v = (exit as { value: R }).value;
    if (!v.session) {
      return c.json({ error: "not_found", id }, 404);
    }
    return c.json(envelope("session.get", { session: v.session, matches: v.matches }));
  });

  // GET /sessions/:id/state
  app.get("/sessions/:id/state", async (c) => {
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
        return c.json({ error: "not_found", id }, 404);
      }
      return c.json({ error: "internal", cause }, 500);
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
  app.get("/sessions/:id/graph", async (c) => {
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
        return c.json({ error: "not_found", id }, 404);
      }
      return c.json({ error: "internal", cause }, 500);
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

  // GET /sessions/:id/recovery — v0.1 surface, 3 fields only.
  // v0.2 fields (related_sessions, suggested_next_steps) are
  // intentionally NOT emitted. The shape lock is enforced by test
  // #4 (state-graph-edges.test.ts) which asserts the response has
  // exactly these keys and nothing else.
  app.get("/sessions/:id/recovery", async (c) => {
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
        return c.json({ error: "not_found", id }, 404);
      }
      return c.json({ error: "internal", cause }, 500);
    }
    const v = (exit as {
      value: {
        state: import("@cognit/core/state").SessionState;
      };
    }).value;
    const state = v.state;

    const rejected_hypotheses = Array.from(state.hypotheses.values())
      .filter((h) => h.current_state === "rejected")
      .map((h) => ({
        id: h.id,
        title: h.title,
        text: h.text,
        reason: h.current_reason,
        reason_type: h.reason_type,
        superseded_by_id: h.superseded_by_id,
        created_at: h.created_at,
      }));

    const accepted_decisions = Array.from(state.decisions.values())
      .filter((d) => d.state === "accepted")
      .map((d) => ({
        id: d.id,
        text: d.text,
        based_on_conclusion_ids: d.based_on_conclusion_ids,
        created_at: d.created_at,
      }));

    const verified_conclusions = Array.from(state.conclusions.values())
      .filter((c2) => c2.state === "verified")
      .map((c2) => ({
        id: c2.id,
        text: c2.text,
        verification_id: c2.verification_id,
        supporting_evidence_ids: c2.supporting_evidence_ids,
        created_at: c2.created_at,
      }));

    return c.json(
      envelope("session.recovery", {
        session_id: id,
        rejected_hypotheses,
        verified_conclusions,
        accepted_decisions,
      }),
    );
  });

  // Mutations (POST /sessions, pause, close, resume) live in a
  // sibling module to keep this file readable. Both modules share
  // the same Hono app — `app.route` accumulates handlers.
  registerSessionsMutations(app, deps);
};