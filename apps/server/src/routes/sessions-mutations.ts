/**
 * apps/server/src/routes/sessions-mutations.ts — POST handlers for
 * session lifecycle. Split from `sessions.ts` because the read paths
 * are short and the mutations each need their own body parsing +
 * error mapping.
 *
 *   POST /sessions                   — create, 201
 *   POST /sessions/:id/pause         — pause,  200 / 404 / 409
 *   POST /sessions/:id/close         — close,  200 / 404 / 409
 *   POST /sessions/:id/resume        — resume, 200 / 404 / 409
 *   POST /sessions/:id/dry-run       — read-only diff (200 / 404 / 500)
 *   POST /sessions/:id/snapshot      — force snapshot (200 / 404 / 500)
 *   POST /sessions/:id/export        — full state + markdown (200 / 404 / 500)
 *
 * Every mutation goes through `SessionService.{create,pause,close,resume}`
 * so the redaction boundary + constraint chokepoint + bus publish
 * chokepoint all stay in effect.
 *
 * Phase 7r.5 (recovery actions): dry-run / snapshot / export. Two are
 * read-only (dry-run, export) and one writes a new `snapshots` row
 * (snapshot). The snapshot path bypasses `SessionService.takeSnapshot`
 * (which is idempotent and would short-circuit if a snapshot already
 * covers every event) and calls `SnapshotService.write` directly so
 * the dashboard's "force snapshot" button always lands a new row.
 */
import { Effect } from "effect";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  SessionService,
  SnapshotService,
  type SessionRow,
  type SnapshotRow,
  type ActorType,
  DbError,
} from "@cognit/db";
import type { SessionState } from "@cognit/core/state";
import { envelope } from "../envelope.js";
import { apiErrorResponse } from "../api-error.js";
import type { SessionsRouteDeps, ServerRuntime } from "./sessions.js";

const VALID_ACTOR_TYPES: ReadonlySet<ActorType> = new Set<ActorType>([
  "human",
  "worker",
  "system",
]);

const isString = (x: unknown): x is string => typeof x === "string" && x.length > 0;
const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const parseActor = (
  raw: unknown,
): { ok: true; value: { name: string; type: ActorType } } | { ok: false; error: string } => {
  if (!isObject(raw)) return { ok: false, error: "actor must be an object {name, type}" };
  if (!isString(raw.name)) return { ok: false, error: "actor.name must be a non-empty string" };
  if (!isString(raw.type)) return { ok: false, error: "actor.type must be a non-empty string" };
  if (!VALID_ACTOR_TYPES.has(raw.type as ActorType)) {
    return { ok: false, error: "actor.type must be human|worker|system" };
  }
  return { ok: true, value: { name: raw.name, type: raw.type as ActorType } };
};

const parseJsonBody = async (c: import("hono").Context): Promise<unknown> => {
  try {
    return await c.req.json();
  } catch (e) {
    return { __badJson: (e as Error).message };
  }
};

interface UnknownSessionShape {
  readonly _tag?: string;
  readonly sessionId?: string;
  readonly attempted?: string;
}
const isUnknownSession = (e: unknown): boolean => {
  if (typeof e !== "object" || e === null) return false;
  const t = (e as UnknownSessionShape)._tag;
  return t === "UnknownSession" || t === "UnknownSessionForResume" || t === "UnknownGoalOrId";
};
const unknownSessionId = (e: unknown): string | null => {
  if (typeof e !== "object" || e === null) return null;
  const id = (e as UnknownSessionShape).sessionId ?? (e as UnknownSessionShape).attempted;
  return id ?? null;
};

const isDbError = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { _tag?: string })._tag === "DbError";

const isIllegalTransition = (msg: string): boolean =>
  /cannot pause a closed session|cannot close a session that is already closed|already closed|already paused/i.test(
    msg,
  );

const unwrapCause = (cause: unknown): unknown => {
  // Effect's runPromiseExit wraps the original error in a Cause<E>.
  // `Cause.fail(e)` serialises as `{ _tag: "Fail", error: e }` when
  // passed through JSON.stringify, but the live object shape is a
  // tagged union. We pull the inner error through every known shape.
  if (typeof cause !== "object" || cause === null) return cause;
  const c = cause as { _tag?: string; error?: unknown; failure?: unknown; cause?: unknown };
  if (c.error !== undefined) return c.error;
  if (c.failure !== undefined) return c.failure;
  if (c.cause !== undefined) return unwrapCause(c.cause);
  return cause;
};

const runMutation = async <A,>(
  runtime: ServerRuntime,
  program: Effect.Effect<A, DbError | { _tag: string }, never>,
  c: import("hono").Context,
  successKind: string,
  successStatus: number,
): Promise<Response> => {
  const exit = await runtime.runPromiseExit(program);
  if (exit._tag === "Failure") {
    const cause = unwrapCause((exit as { cause: unknown }).cause);
    if (isUnknownSession(cause)) {
      const id = unknownSessionId(cause) ?? c.req.param("id") ?? "(unknown)";
      return apiErrorResponse(c, "not_found", `session '${id}' not found`, { id });
    }
    if (isDbError(cause)) {
      const message = (cause as { message?: string }).message ?? "";
      if (isIllegalTransition(message)) {
        return apiErrorResponse(c, "conflict", message);
      }
      return apiErrorResponse(c, "internal", message || "session mutation failed");
    }
    return apiErrorResponse(c, "internal", "session mutation failed");
  }
  return c.json(
    envelope(successKind, (exit as { value: unknown }).value),
    successStatus as ContentfulStatusCode,
  );
};

export const registerSessionsMutations = (
  app: Hono,
  deps: SessionsRouteDeps,
): void => {
  const { runtime, projectId } = deps;

  // POST /sessions
  app.post("/api/sessions", async (c) => {
    const raw = await parseJsonBody(c);
    if (typeof raw === "object" && raw !== null && "__badJson" in raw) {
      return apiErrorResponse(
        c,
        "bad_request",
        `body is not JSON: ${(raw as { __badJson: string }).__badJson}`,
      );
    }
    if (!isObject(raw)) {
      return apiErrorResponse(c, "bad_request", "body must be a JSON object");
    }
    if (!isString(raw.goal) || raw.goal.trim().length === 0) {
      return apiErrorResponse(c, "validation_failed", "goal must be a non-empty string");
    }
    if (raw.parent_session_id !== undefined && raw.parent_session_id !== null && !isString(raw.parent_session_id)) {
      return apiErrorResponse(c, "validation_failed", "parent_session_id must be a string");
    }
    const actor = parseActor(raw.actor);
    if (!actor.ok) {
      return apiErrorResponse(c, "validation_failed", actor.error);
    }
    const program = Effect.gen(function* () {
      const service = yield* SessionService;
      return yield* service.create({
        projectId,
        goal: raw.goal as string,
        parentSessionId:
          raw.parent_session_id === undefined || raw.parent_session_id === null
            ? null
            : (raw.parent_session_id as string),
        actor: actor.value,
      });
    });
    type R = { session: SessionRow; event: unknown };
    return runMutation<{ session: SessionRow; event: unknown }>(
      runtime,
      program as Effect.Effect<R, DbError, never>,
      c,
      "session.created",
      201,
    );
  });

  // POST /sessions/:id/pause
  app.post("/api/sessions/:id/pause", async (c) => {
    const id = c.req.param("id");
    const raw = await parseJsonBody(c);
    if (typeof raw === "object" && raw !== null && "__badJson" in raw) {
      return apiErrorResponse(
        c,
        "bad_request",
        `body is not JSON: ${(raw as { __badJson: string }).__badJson}`,
      );
    }
    const actor = parseActor(typeof raw === "object" && raw !== null && "actor" in raw ? (raw as Record<string, unknown>).actor : undefined);
    if (!actor.ok) {
      return apiErrorResponse(c, "validation_failed", actor.error);
    }
    const program = Effect.gen(function* () {
      const service = yield* SessionService;
      return yield* service.pause(id, actor.value);
    });
    type R = { session: SessionRow; event: unknown };
    return runMutation<R>(
      runtime,
      program as Effect.Effect<R, DbError | { _tag: "UnknownSession"; sessionId: string }, never>,
      c,
      "session.paused",
      200,
    );
  });

  // POST /sessions/:id/close
  app.post("/api/sessions/:id/close", async (c) => {
    const id = c.req.param("id");
    const raw = await parseJsonBody(c);
    if (typeof raw === "object" && raw !== null && "__badJson" in raw) {
      return apiErrorResponse(
        c,
        "bad_request",
        `body is not JSON: ${(raw as { __badJson: string }).__badJson}`,
      );
    }
    const actor = parseActor(typeof raw === "object" && raw !== null && "actor" in raw ? (raw as Record<string, unknown>).actor : undefined);
    if (!actor.ok) {
      return apiErrorResponse(c, "validation_failed", actor.error);
    }
    const program = Effect.gen(function* () {
      const service = yield* SessionService;
      return yield* service.close(id, actor.value);
    });
    type R = { session: SessionRow; event: unknown };
    return runMutation<R>(
      runtime,
      program as Effect.Effect<R, DbError | { _tag: "UnknownSession"; sessionId: string }, never>,
      c,
      "session.closed",
      200,
    );
  });

  // POST /sessions/:id/resume
  app.post("/api/sessions/:id/resume", async (c) => {
    const id = c.req.param("id");
    const raw = await parseJsonBody(c);
    if (typeof raw === "object" && raw !== null && "__badJson" in raw) {
      return apiErrorResponse(
        c,
        "bad_request",
        `body is not JSON: ${(raw as { __badJson: string }).__badJson}`,
      );
    }
    if (!isObject(raw)) {
      return apiErrorResponse(c, "bad_request", "body must be a JSON object");
    }
    const actor = parseActor(raw.actor);
    if (!actor.ok) {
      return apiErrorResponse(c, "validation_failed", actor.error);
    }
    // fork_on_resume defaults to true per plan §5.4.2.
    const forkOnResume = raw.fork_on_resume === undefined ? true : Boolean(raw.fork_on_resume);
    const program = Effect.gen(function* () {
      const service = yield* SessionService;
      return yield* service.resume({
        projectId,
        idOrGoal: id,
        fork: forkOnResume,
        actor: actor.value,
      });
    });
    type R = {
      session: SessionRow;
      event: unknown;
      parent: SessionRow;
      forked: boolean;
    };
    return runMutation<R>(
      runtime,
      program as Effect.Effect<
        R,
        | DbError
        | { _tag: "UnknownSessionForResume"; attempted: string }
        | { _tag: "SessionAlreadyClosed"; sessionId: string },
        never
      >,
      c,
      "session.resumed",
      200,
    );
  });

  // POST /sessions/:id/dry-run — read-only simulation.
  //
  // Returns the counts the reducer would produce if the session were
  // replayed from scratch plus the last event id it would walk to.
  // No events are written and the bus is not touched. AC-7.18 holds.
  app.post("/api/sessions/:id/dry-run", async (c) => {
    const id = c.req.param("id");
    const program = Effect.gen(function* () {
      const service = yield* SessionService;
      const show = yield* service.show(id);
      return show;
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
      return apiErrorResponse(c, "internal", "session.dry_run: query failed");
    }
    const v = (exit as {
      value: {
        state: SessionState;
        last_event_id: string | null;
      };
    }).value;
    const eventCount = v.state.timeline.length;
    return c.json(
      envelope("session.dry_run", {
        session_id: id,
        would_reduce_events: eventCount,
        would_reach_state: {
          findings_count: v.state.findings.length,
          hypotheses_count: v.state.hypotheses.size,
          decisions_count: v.state.decisions.size,
          conclusions_count: v.state.conclusions.size,
        },
        last_known_event_id: v.state.last_event_id ?? v.last_event_id ?? null,
      }),
    );
  });

  // POST /sessions/:id/snapshot — force a fresh `snapshots` row.
  //
  // Goes directly to `SnapshotService.write` so the call always lands
  // a new row (the dashboard uses this as "snapshot now"; idempotency
  // is not the right behaviour for that). Returns the snapshot id so
  // the caller can fetch it via GET /snapshots/:id or the recovery
  // endpoints.
  app.post("/api/sessions/:id/snapshot", async (c) => {
    const id = c.req.param("id");
    const program = Effect.gen(function* () {
      const sessions = yield* SessionService;
      const snapshots = yield* SnapshotService;
      const show = yield* sessions.show(id);
      const state = show.state;
      const eventCount = state.timeline.length;
      const lastEventId = state.last_event_id;
      if (lastEventId === null) {
        return yield* Effect.fail(
          new DbError({
            message: "session.snapshot: no events to snapshot",
            cause: undefined,
          }),
        );
      }
      return yield* snapshots.write({
        sessionId: id,
        state,
        eventId: lastEventId,
        eventCount,
      });
    });
    const exit = await runtime.runPromiseExit(
      program as Effect.Effect<SnapshotRow, unknown, never>,
    );
    if (exit._tag === "Failure") {
      const cause = unwrapCause((exit as { cause: unknown }).cause);
      if (isUnknownSession(cause)) {
        return apiErrorResponse(c, "not_found", `session '${id}' not found`, { id });
      }
      if (isDbError(cause)) {
        const message = (cause as { message?: string }).message ?? "";
        return apiErrorResponse(c, "internal", message || "session.snapshot: write failed");
      }
      return apiErrorResponse(c, "internal", "session.snapshot: write failed");
    }
    const v = (exit as { value: SnapshotRow }).value;
    return c.json(
      envelope("session.snapshot", {
        snapshot_id: v.id,
        session_id: v.session_id,
        event_id: v.event_id,
        event_count: v.event_count,
      }),
    );
  });

  // POST /sessions/:id/export — read-only export of the full
  // SessionState plus a markdown summary of the recovery block. Used
  // by the dashboard "export" button. State is serialised with the
  // same key-sorted, Map→object transform that `SnapshotService.write`
  // uses so the wire format round-trips through `rehydrateSessionState`.
  app.post("/api/sessions/:id/export", async (c) => {
    const id = c.req.param("id");
    const program = Effect.gen(function* () {
      const service = yield* SessionService;
      const show = yield* service.show(id);
      return show;
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
      return apiErrorResponse(c, "internal", "session.export: query failed");
    }
    const v = (exit as {
      value: {
        session: SessionRow;
        state: SessionState;
      };
    }).value;
    const state = v.state;
    return c.json(
      envelope("session.export", {
        session_id: id,
        goal: state.goal,
        status: state.status,
        state: serialiseStateForExport(state),
        markdown: buildRecoveryMarkdown(state),
      }),
    );
  });
};

// ---------------------------------------------------------------------------
// Recovery-action helpers
// ---------------------------------------------------------------------------

/**
 * Convert a SessionState into a JSON-safe value. Same key-sort +
 * Map→object transform `SnapshotService` uses so the export round-trips
 * through `rehydrateSessionState` if a downstream consumer wants to
 * rehydrate the state. Maps are materialised as plain objects keyed
 * by the entity id.
 */
const serialiseStateForExport = (state: SessionState): unknown => {
  const sortKeys = (v: unknown): unknown => {
    if (v instanceof Map) {
      const obj: Record<string, unknown> = {};
      for (const [k, val] of v.entries()) obj[String(k)] = val;
      return sortKeys(obj);
    }
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(obj).sort()) sorted[k] = sortKeys(obj[k]);
      return sorted;
    }
    return v;
  };
  return sortKeys(state);
};

/**
 * Build a short markdown summary of the recovery block: rejected
 * hypotheses, verified conclusions, and accepted decisions. Used by
 * the export endpoint so the dashboard can show a copy-pasteable
 * artefact without pulling the full state JSON into the UI.
 */
const buildRecoveryMarkdown = (state: SessionState): string => {
  const rejectedHypotheses: Array<{ title: string }> = [];
  for (const h of state.hypotheses.values()) {
    if (h.current_state === "rejected") rejectedHypotheses.push({ title: h.title });
  }
  const verifiedConclusions: Array<{ text: string }> = [];
  for (const c of state.conclusions.values()) {
    if (c.state === "verified") verifiedConclusions.push({ text: c.text });
  }
  const acceptedDecisions: Array<{ text: string }> = [];
  for (const d of state.decisions.values()) {
    if (d.state === "accepted") acceptedDecisions.push({ text: d.text });
  }
  const lines: string[] = [];
  lines.push(`# Recovery summary for session ${state.session_id}`);
  lines.push("");
  lines.push(`## Rejected hypotheses (${rejectedHypotheses.length})`);
  for (const h of rejectedHypotheses) lines.push(`- ${h.title}`);
  lines.push("");
  lines.push(`## Verified conclusions (${verifiedConclusions.length})`);
  for (const c of verifiedConclusions) lines.push(`- ${c.text}`);
  lines.push("");
  lines.push(`## Accepted decisions (${acceptedDecisions.length})`);
  for (const d of acceptedDecisions) lines.push(`- ${d.text}`);
  lines.push("");
  return lines.join("\n");
};