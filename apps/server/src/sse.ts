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
} from "./event-queries.js";
import type { ServerRuntime } from "./routes/sessions.js";

export interface SseOptions {
  /** Project id to scope the replay query. */
  readonly projectId: string;
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
export const sseHandler = (runtime: ServerRuntime, opts: SseOptions) => {
  const replayLimit = opts.replayLimit ?? DEFAULT_REPLAY;
  const eventName = opts.eventName ?? "event";
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const retryMs = opts.retryMs ?? DEFAULT_RETRY_MS;
  const projectId = opts.projectId;

  return async (c: Context): Promise<Response> => {
    const encoder = new TextEncoder();
    const lastEventIdRaw = c.req.header("last-event-id");
    const lastEventId = isString(lastEventIdRaw) ? lastEventIdRaw : null;

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
          const replay = lastEventId
            ? yield* listAfterEventAcrossProjectE(projectId, lastEventId, replayLimit)
            : yield* listRecentAcrossProjectE(projectId, replayLimit);
          for (const r of replay) safeEnqueue(format(r));

          // Subscribe to bus for live delivery.
          const bus = yield* EventBus;
          const { queue, unsub } = yield* bus.subscribe();

          // Drain loop: forward every new row.
          const drain = Effect.gen(function* () {
            while (true) {
              const row = yield* Queue.take(queue);
              safeEnqueue(format(row));
            }
          });
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
        });

        await runtime.runPromise(program as Effect.Effect<void, never, never>);
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