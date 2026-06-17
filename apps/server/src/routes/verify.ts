/**
 * apps/server/src/routes/verify.ts — verification lifecycle HTTP surface.
 *
 *   POST /verify                    start (201, state="started")
 *   POST /verify/:id/cancel         cancel (200, idempotent on terminal)
 *
 * Start side:
 *   1. validate body
 *   2. emit `verification_started` event via `SessionService.appendEvent`
 *      (the event id becomes the verification id; published via the
 *      5.1 bus chokepoint so SSE subscribers see it immediately)
 *   3. fork `runVerification` from `@cognit/verification` against
 *      `/bin/sh -c <command>` in `process.cwd()`; the terminal event
 *      (passed / failed / errored) is appended through the same
 *      chokepoint with `parent_verification_id = verificationId`
 *
 * Cancel side:
 *   1. look up the verification_started event by id; 404 if missing
 *   2. if a terminal event already exists (passed / failed / errored /
 *      cancelled) → 200 with current state, idempotent
 *   3. else signal the forked AbortController, mark the control
 *      cancelled so the terminal callback skips re-emitting, append
 *      `verification_cancelled` with `parent_verification_id`
 *
 * The in-memory `controls` map is process-local; restarting the
 * server discards stale controllers. A terminal event in the log
 * still surfaces the resolved state on subsequent GETs.
 */
import { Effect } from "effect";
import { Hono } from "hono";
import {
  DbConnection,
  SessionService,
  type ActorType,
  type EventRow,
} from "@cognit/db";
import {
  runVerification,
  type TerminalEvent,
} from "@cognit/verification";
import { envelope } from "../envelope.js";
import { apiErrorResponse } from "../api-error.js";
import type { ServerRuntime } from "./sessions.js";

const VALID_ACTOR_TYPES = new Set<ActorType>(["human", "worker", "system"]);
const VALID_VERIFICATION_TYPES = new Set([
  "test",
  "lint",
  "build",
  "exec",
  "typecheck",
]);
const TERMINAL_TYPES = [
  "verification_passed",
  "verification_failed",
  "verification_errored",
  "verification_cancelled",
] as const;

const isString = (x: unknown): x is string => typeof x === "string" && x.length > 0;
const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

interface VerifyControl {
  readonly abort: AbortController;
  cancelled: boolean;
}

/** Process-local map: verificationId → control. */
const controls = new Map<string, VerifyControl>();

const parseActor = (
  raw: unknown,
): { ok: true; value: { name: string; type: ActorType } } | { ok: false; error: string } => {
  if (!isObject(raw)) return { ok: false, error: "actor must be an object" };
  if (!isString(raw.name)) return { ok: false, error: "actor.name must be a non-empty string" };
  if (!isString(raw.type) || !VALID_ACTOR_TYPES.has(raw.type as ActorType)) {
    return { ok: false, error: "actor.type must be human|worker|system" };
  }
  return { ok: true, value: { name: raw.name, type: raw.type as ActorType } };
};

export interface VerifyRouteDeps {
  readonly runtime: ServerRuntime;
  readonly projectId: string;
}

export const registerVerifyRoutes = (app: Hono, deps: VerifyRouteDeps): void => {
  const { runtime } = deps;

  // POST /verify
  app.post("/verify", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch (e) {
      return apiErrorResponse(
        c,
        "bad_request",
        `body is not JSON: ${(e as Error).message}`,
      );
    }
    if (!isObject(raw)) {
      return apiErrorResponse(c, "bad_request", "body must be a JSON object");
    }
    const sessionId = isString(raw.session_id) ? raw.session_id : null;
    if (sessionId === null) {
      return apiErrorResponse(c, "bad_request", "session_id must be a non-empty string");
    }
    const command = isString(raw.command) ? raw.command : null;
    if (command === null || command.length === 0) {
      return apiErrorResponse(c, "bad_request", "command must be a non-empty string");
    }
    const type = isString(raw.type) && VALID_VERIFICATION_TYPES.has(raw.type) ? raw.type : null;
    if (type === null) {
      return apiErrorResponse(
        c,
        "bad_request",
        `type must be one of ${[...VALID_VERIFICATION_TYPES].join("|")}`,
      );
    }
    const timeoutMs = typeof raw.timeout_ms === "number" ? raw.timeout_ms : undefined;
    const linkedHypothesisId = isString(raw.linked_hypothesis_id) ? raw.linked_hypothesis_id : undefined;
    const correlationId = isString(raw.correlation_id) ? raw.correlation_id : undefined;
    const actorParsed = parseActor(raw.actor);
    if (!actorParsed.ok) {
      return apiErrorResponse(c, "bad_request", actorParsed.error);
    }

    const program = Effect.gen(function* () {
      const svc = yield* SessionService;
      const { event, snapshotTaken } = yield* svc.appendEvent({
        sessionId,
        type: "verification_started",
        payload: {
          command,
          type,
          linked_hypothesis_id: linkedHypothesisId ?? null,
          ...(timeoutMs !== undefined ? { expected_duration_ms: timeoutMs } : {}),
        },
        actor: actorParsed.value,
        ...(linkedHypothesisId !== undefined ? { linkedHypothesisId } : {}),
        ...(correlationId !== undefined ? { correlationId } : {}),
      });
      return { event, snapshotTaken };
    });

    const exit = await runtime.runPromiseExit(
      program as unknown as Effect.Effect<{ event: EventRow; snapshotTaken: boolean }, unknown, never>,
    );
    if (exit._tag === "Failure") {
      const cause = (exit as { cause: unknown }).cause;
      const err = JSON.stringify(cause);
      if (err.includes("SessionClosed")) {
        return apiErrorResponse(c, "session_unavailable", "session is not accepting events");
      }
      if (err.includes("UnknownSession")) {
        return apiErrorResponse(c, "not_found", `session '${sessionId}' not found`, { session_id: sessionId });
      }
      return apiErrorResponse(c, "internal", "verification.started: append failed");
    }

    const value = (exit as { value: { event: EventRow; snapshotTaken: boolean } }).value;
    const verificationId = value.event.id;

    // Fork the subprocess. onTerminal appends through the same
    // chokepoint so SSE subscribers see the lifecycle.
    const ctrl: VerifyControl = { abort: new AbortController(), cancelled: false };
    controls.set(verificationId, ctrl);

    const onTerminal = (terminal: TerminalEvent): Effect.Effect<void, never, never> =>
      Effect.gen(function* () {
        if (ctrl.cancelled) return;
        const svc = yield* SessionService;
        yield* svc.appendEvent({
          sessionId,
          type: terminal.type,
          payload: terminal.payload,
          actor: actorParsed.value,
          parentVerificationId: verificationId,
        });
        controls.delete(verificationId);
      }).pipe(
        Effect.catchAll(() => Effect.succeed(undefined as void)),
      ) as unknown as Effect.Effect<void, never, never>;

    if (timeoutMs !== undefined) {
      const tid = setTimeout(() => ctrl.abort.abort(), timeoutMs);
      void tid;
    }

    const runProgram = runVerification({
      command: ["sh", "-c", command],
      cwd: process.cwd(),
      env: process.env,
      signal: ctrl.abort.signal,
      paths: { artifacts: `${process.cwd()}/.cognit/artifacts` },
      onTerminal,
    }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
    runtime.runFork(runProgram);

    return c.json(
      envelope("verification.started", {
        id: verificationId,
        session_id: sessionId,
        command,
        type,
        state: "started",
        snapshot_taken: value.snapshotTaken,
      }),
      201,
    );
  });

  // POST /verify/:id/cancel
  app.post("/verify/:id/cancel", async (c) => {
    const verificationId = c.req.param("id");
    let raw: Record<string, unknown> = {};
    try {
      const parsed: unknown = await c.req.json();
      if (isObject(parsed)) raw = parsed;
    } catch {
      // body optional
    }
    const actorParsed = parseActor(raw["actor"]);
    if (!actorParsed.ok) {
      return apiErrorResponse(c, "bad_request", actorParsed.error);
    }
    const reason = isString(raw["reason"]) ? raw["reason"] : "user_cancelled";

    // 1. Look up the started event + any terminal in one query.
    type LookupResult =
      | { started: null; terminal: null }
      | {
          started: EventRow;
          terminal: { row: EventRow; state: "passed" | "failed" | "errored" | "cancelled" } | null;
        };
    const lookupProgram: Effect.Effect<LookupResult, never, DbConnection> = Effect.gen(function* () {
      const conn = yield* DbConnection;
      const started = conn.handle.get<EventRow>(
        "SELECT * FROM events WHERE id = ? AND type = 'verification_started'",
        [verificationId],
      ) ?? null;
      if (!started) return { started: null, terminal: null };
      const placeholders = TERMINAL_TYPES.map(() => "?").join(",");
      const termRow = conn.handle.get<EventRow>(
        `SELECT * FROM events
         WHERE parent_verification_id = ?
           AND type IN (${placeholders})
         ORDER BY created_at DESC
         LIMIT 1`,
        [verificationId, ...TERMINAL_TYPES],
      );
      let terminal: { row: EventRow; state: "passed" | "failed" | "errored" | "cancelled" } | null = null;
      if (termRow) {
        switch (termRow.type) {
          case "verification_passed": terminal = { row: termRow, state: "passed" }; break;
          case "verification_failed": terminal = { row: termRow, state: "failed" }; break;
          case "verification_errored": terminal = { row: termRow, state: "errored" }; break;
          case "verification_cancelled": terminal = { row: termRow, state: "cancelled" }; break;
        }
      }
      return { started, terminal };
    });
    const lookupExit = await runtime.runPromiseExit(
      lookupProgram as unknown as Effect.Effect<unknown, unknown, never>,
    );
    if (lookupExit._tag === "Failure") {
      return apiErrorResponse(c, "internal", "verification.cancel: lookup failed");
    }
    const looked = (lookupExit as { value: LookupResult }).value;
    if (!looked.started) {
      return apiErrorResponse(c, "not_found", `verification '${verificationId}' not found`, { id: verificationId });
    }

    // 2. Idempotent terminal: return current state at 200.
    if (looked.terminal) {
      return c.json(
        envelope("verification.cancelled", {
          id: verificationId,
          session_id: looked.started.session_id,
          state: looked.terminal.state,
          idempotent: true,
        }),
      );
    }

    // 3. Mark the control cancelled BEFORE aborting so the terminal
    //    callback (which fires when the child dies) skips re-emitting
    //    a passed/failed/errored event that would race with us.
    const ctrl = controls.get(verificationId);
    if (ctrl) {
      ctrl.cancelled = true;
      ctrl.abort.abort();
      controls.delete(verificationId);
    }

    const sessionId = looked.started.session_id;
    const cancelProgram = Effect.gen(function* () {
      const svc = yield* SessionService;
      const { event } = yield* svc.appendEvent({
        sessionId,
        type: "verification_cancelled",
        payload: { reason },
        actor: actorParsed.value,
        parentVerificationId: verificationId,
      });
      return event;
    });
    const cancelExit = await runtime.runPromiseExit(
      cancelProgram as unknown as Effect.Effect<EventRow, unknown, never>,
    );
    if (cancelExit._tag === "Failure") {
      return apiErrorResponse(c, "internal", "verification.cancel: append failed");
    }

    return c.json(
      envelope("verification.cancelled", {
        id: verificationId,
        session_id: sessionId,
        state: "cancelled",
        idempotent: false,
      }),
    );
  });
};