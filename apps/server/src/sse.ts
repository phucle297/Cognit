/**
 * apps/server/src/sse.ts — Server-Sent Events stream.
 *
 * Wire format per frame:
 *   id: <row.id>\nevent: <name>\ndata: <json>\n\n
 *
 * The `id:` field is required: when a browser EventSource
 * auto-reconnects, it sends `Last-Event-ID` back, and we resume
 * replay from that cursor instead of re-emitting the recent tail.
 * Without `id:`, the browser would replay the default tail again,
 * causing duplicate frames on transient network drops.
 *
 * Replay strategy:
 *   - If client sends `Last-Event-ID`, replay events strictly newer
 *     than that id (ULID lex order), bounded by `replayLimit`.
 *   - Otherwise replay the last `replayLimit` events project-wide.
 * Default `replayLimit` is 1000 (was 50 in phase 3). SSE is now
 * crash-resilient: a server restart loses at most the gap since the
 * last client-received id, not 50 events.
 *
 * Then subscribe to the bus and forward every new row. If the client
 * disconnects (request aborted), the bus subscription is unsubscribed
 * and the response stream is closed.
 *
 * Heartbeat: SSE comment `: ping\n\n` every `heartbeatMs` (default
 * 15s). Keeps idle proxies from dropping the connection. Tests may
 * shorten it via the option.
 *
 * `retry: 5000` is emitted as the first frame so EventSource waits
 * 5s before retrying after a server-side close (covers graceful
 * shutdown during deploys).
 *
 * Per-stream shutdown: `cleanup` calls `unsub` only — the bus stays
 * alive for other SSE clients. Server-wide shutdown (SIGTERM) calls
 * `bus.shutdown()` from `apps/server/src/index.ts`, which rejects all
 * in-flight `Queue.take` fibers so every drain loop exits and the
 * controller closes.
 */
import { Effect, Fiber, Queue } from "effect";
import type { Context } from "hono";
import type { EventRow } from "@cognit/db";
import { EventBus } from "./bus.js";
import {
  listRecentAcrossProjectE,
  listAfterEventAcrossProjectE,
  listRecentForSessionTypedE,
  listAfterEventForSessionTypedE,
} from "./event-queries.js";
import type { ServerRuntime } from "./routes/sessions.js";

export interface SseOptions {
  /** Project id to scope the replay query. */
  readonly projectId: string;
  /**
   * When set, the replay AND live drain scope to this session only.
   * Live rows whose `session_id` does not match are dropped before
   * they hit the wire. Combined with `types`, this gives a small
   * per-tab feed (e.g. AI-reasoning tab only sees its own session's
   * `hypothesis_ranked` events).
   */
  readonly sessionId?: string;
  /**
   * Optional set of event types to forward. When set, the replay
   * only replays events of these types AND the live drain drops
   * anything else. Empty array would forward nothing; the SSE
   * handler treats an empty array the same as "unset" (forwards
   * everything, scoped only by `sessionId`).
   */
  readonly types?: ReadonlyArray<string>;
  /** How many recent events to replay before switching to live. */
  readonly replayLimit?: number;
  /** SSE frame name (used as `event:` field). Defaults to "event". */
  readonly eventName?: string;
  /** Heartbeat interval (ms). Defaults to 15000. Tests may shorten. */
  readonly heartbeatMs?: number;
  /** Initial reconnect hint sent as `retry:`. Defaults to 5000. */
  readonly retryMs?: number;
}

const DEFAULT_REPLAY = 1000;
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_RETRY_MS = 5_000;

const isString = (x: unknown): x is string => typeof x === "string" && x.length > 0;

/**
 * Hono handler factory. Returns a `Response` whose body is a
 * `ReadableStream` of SSE frames.
 */
// Crockford base32 ULID alphabet. Used to gate `last_event_id` so we
// never feed garbage into the SQL `id > ?` predicate (a 10kB string
// would otherwise still parse as a valid SQLite parameter but
// break ULID lex ordering silently — replay would skip rows the
// client already saw).
export const CROCKFORD_ALPHABET_RE = /^[0-9A-HJKMNP-TV-Z]*$/;
export const LAST_EVENT_ID_MAX_LEN = 64;

export const sseHandler = (runtime: ServerRuntime, opts: SseOptions) => {
  const replayLimit = opts.replayLimit ?? DEFAULT_REPLAY;
  const eventName = opts.eventName ?? "event";
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const retryMs = opts.retryMs ?? DEFAULT_RETRY_MS;
  const projectId = opts.projectId;
  const sessionId = opts.sessionId;
  // `types` with length 0 is treated as "unset" so the existing
  // global stream (`sseHandler(runtime, { projectId })`) keeps its
  // behaviour — it does not pass `types`, so `opts.types` is
  // `undefined`. Callers that want a typed stream pass a non-empty
  // array.
  const types = opts.types && opts.types.length > 0 ? opts.types : null;

  return async (c: Context): Promise<Response> => {
    const encoder = new TextEncoder();
    // Accept either the standard `Last-Event-ID` header (used by
    // native EventSource on reconnect) OR the `?last_event_id=`
    // query string (the dashboard's use-event-source hook appends
    // this because the native API can't set the header on a fresh
    // connection — see apps/dashboard/src/shared/api/use-event-source.ts).
    const lastEventIdRaw =
      c.req.header("last-event-id") ?? c.req.query("last_event_id");
    // Cap length and validate Crockford base32 BEFORE we touch SQL.
    // Without this, an attacker-controlled cursor (e.g. a 64kB string)
    // would push a heavy parameter into the `id > ?` predicate and
    // could also break the lex ordering that the cursor relies on
    // (replay skipping rows the client already saw).
    const lastEventId =
      isString(lastEventIdRaw) &&
      lastEventIdRaw.length <= LAST_EVENT_ID_MAX_LEN &&
      CROCKFORD_ALPHABET_RE.test(lastEventIdRaw)
        ? lastEventIdRaw
        : null;

    const format = (row: EventRow) =>
      encoder.encode(
        `id: ${row.id}\nevent: ${eventName}\ndata: ${JSON.stringify(row)}\n\n`,
      );
    const formatRetry = () => encoder.encode(`retry: ${retryMs}\n\n`);
    const formatPing = () => encoder.encode(`: ping\n\n`);

    let cleanup: (() => void) | null = null;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const safeEnqueue = (chunk: Uint8Array) => {
          try {
            controller.enqueue(chunk);
          } catch {
            /* stream closed */
          }
        };

        // Emit the reconnect hint before anything else so an
        // EventSource client picks it up immediately on connect.
        safeEnqueue(formatRetry());

        const program = Effect.gen(function* () {
          // Replay: cursor-aware if Last-Event-ID present, else tail.
          // Scoped to (sessionId, types) when both are set; otherwise
          // falls back to the project-wide tail so the global stream
          // behaviour is unchanged.
          let replay: ReadonlyArray<EventRow>;
          if (sessionId !== undefined && types !== null) {
            replay = lastEventId
              ? yield* listAfterEventForSessionTypedE(
                  sessionId,
                  types,
                  lastEventId,
                  replayLimit,
                )
              : yield* listRecentForSessionTypedE(
                  sessionId,
                  types,
                  replayLimit,
                );
          } else {
            replay = lastEventId
              ? yield* listAfterEventAcrossProjectE(projectId, lastEventId, replayLimit)
              : yield* listRecentAcrossProjectE(projectId, replayLimit);
          }
          for (const r of replay) safeEnqueue(format(r));

          // Subscribe to bus for live delivery.
          const bus = yield* EventBus;
          const { queue, unsub } = yield* bus.subscribe();

          // Live drain. When `sessionId` or `types` is set, we filter
          // rows in JS before enqueueing. The bus publishes every
          // project event to every subscriber — re-subscribing per
          // type would need bus surgery, and the dashboard tabs that
          // consume this are O(sessions open at once), not O(events).
          const matches = (row: EventRow): boolean => {
            if (sessionId !== undefined && row.session_id !== sessionId) return false;
            if (types !== null && !types.includes(row.type)) return false;
            return true;
          };

          // Drain loop: forward every new row that passes the filter.
          // Mirrors the heartbeat pattern: any failure (Queue shutdown,
          // defect) is swallowed so the SSE handler exits cleanly
          // instead of leaking a 200 + empty stream.
          const drain = Effect.gen(function* () {
            while (true) {
              const row = yield* Queue.take(queue);
              if (!matches(row)) continue;
              safeEnqueue(format(row));
            }
          }).pipe(Effect.catchAllCause(() => Effect.void));
          const drainFiber = yield* Effect.forkDaemon(drain);

          // Heartbeat ticker: SSE comment every heartbeatMs.
          const heartbeat = Effect.gen(function* () {
            while (true) {
              yield* Effect.sleep(`${heartbeatMs} millis`);
              safeEnqueue(formatPing());
            }
          }).pipe(Effect.catchAll(() => Effect.void));
          const heartbeatFiber = yield* Effect.forkDaemon(heartbeat);

          cleanup = () => {
            void runtime.runFork(
              Effect.zipRight(
                Effect.zipRight(unsub, Fiber.interrupt(drainFiber)),
                Fiber.interrupt(heartbeatFiber),
              ),
            );
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          };
        }).pipe(
          // If the bus subscribe() or replay fails (DB error, missing
          // service, layer mismatch, etc.), don't leak a 200 + empty
          // stream — emit a single `event: error` SSE frame carrying
          // the v1 api_error envelope and close so EventSource
          // triggers its retry. We use catchAllCause (not catchAll)
          // because a missing service produces a defect, which lives
          // on the cause channel not the error channel.
          Effect.catchAllCause((cause) => {
            const requestId = c.get("requestId") ?? "";
            const payload = JSON.stringify({
              kind: "api_error",
              code: "internal",
              message: "event stream subscribe failed",
              request_id: requestId,
            });
            safeEnqueue(
              encoder.encode(`event: error\ndata: ${payload}\n\n`),
            );
            process.stderr.write(
              `sse: subscribe failed: ${JSON.stringify(cause)}\n`,
            );
            try {
              controller.close();
            } catch {
              /* already closed */
            }
            return Effect.void;
          }),
        );

        // Defensive: the Effect.catchAllCause handler above already emits
        // the v1 `event: error` frame when the program fails. The
        // try/catch + .catch around runPromise is a belt-and-suspenders
        // for any failure that escapes the Effect layer (e.g. a
        // missing service lookup that throws synchronously rather
        // than producing a Cause).
        const rid = c.get("requestId") ?? "";
        try {
          const p = runtime.runPromise(program as Effect.Effect<void, never, never>);
          void p.catch((e: unknown) => {
            process.stderr.write(
              `sse: runPromise rejected: ${JSON.stringify(e)}\n`,
            );
            const payload = JSON.stringify({
              kind: "api_error",
              code: "internal",
              message: "event stream subscribe failed",
              request_id: rid,
            });
            safeEnqueue(
              encoder.encode(`event: error\ndata: ${payload}\n\n`),
            );
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          });
        } catch (e) {
          process.stderr.write(
            `sse: runPromise sync throw: ${JSON.stringify(e)}\n`,
          );
          const payload = JSON.stringify({
            kind: "api_error",
            code: "internal",
            message: "event stream subscribe failed",
            request_id: rid,
          });
          safeEnqueue(
            encoder.encode(`event: error\ndata: ${payload}\n\n`),
          );
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      },
      cancel() {
        cleanup?.();
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        // X-Accel-Buffering tells nginx (and most reverse proxies) to
        // NOT buffer the SSE stream — without it nginx waits for a
        // full chunk before flushing, breaking live delivery.
        "x-accel-buffering": "no",
      },
    });
  };
};