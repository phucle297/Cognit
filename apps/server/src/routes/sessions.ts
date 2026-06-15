/**
 * apps/server/src/routes/sessions.ts — `GET /sessions`,
 * `GET /sessions/:id/state`, `GET /sessions/:id`.
 *
 * `GET /sessions/:id/state` returns the `SessionStateView` (the
 * same shape `cognit session show` prints). Backed by
 * `SessionService.show` which already does the snapshot+tail replay
 * and returns the projected state.
 *
 * For v1 the state view *is* the `SessionState` from `@cognit/core`.
 * We don't re-shape it — a future phase 4 might project a
 * `SessionStateView` with derived fields (counts, freshness) but
 * the same on-the-wire shape keeps client and CLI consistent.
 */
import { Effect, Fiber } from "effect";
import { Hono } from "hono";
import { SessionService, type SessionRow, type SnapshotRow } from "@cognit/db";
import type { SessionState } from "@cognit/core/state";
import { envelope } from "../envelope.js";

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
      return c.json({ error: "internal", cause: (exit as { cause: unknown }).cause }, 500);
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
};
