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
 *
 * Every mutation goes through `SessionService.{create,pause,close,resume}`
 * so the redaction boundary + constraint chokepoint + bus publish
 * chokepoint all stay in effect.
 */
import { Effect } from "effect";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  SessionService,
  type SessionRow,
  type ActorType,
  DbError,
} from "@cognit/db";
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
  app.post("/sessions", async (c) => {
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
  app.post("/sessions/:id/pause", async (c) => {
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
  app.post("/sessions/:id/close", async (c) => {
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
  app.post("/sessions/:id/resume", async (c) => {
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
};