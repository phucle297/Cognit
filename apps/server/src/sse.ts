/**
 * apps/server/src/sse.ts — Server-Sent Events stream.
 *
 * Wire format: each event is a single `data:` frame whose payload
 * is the JSON-serialised `EventRow`. Clients connect with `curl -N`
 * and read line-buffered `data: {...}\n\n` frames.
 *
 * Replay-then-live: on connect, the handler reads the last
 * `replayLimit` events project-wide (default 50) and emits them
 * in order, then subscribes to the bus and forwards every new
 * row. This lets a fresh subscriber see the recent tail and then
 * catch up.
 *
 * If the client disconnects (request aborted), the bus subscription
 * is unsubscribed and the response stream is closed. The store
 * fetch and the bus subscribe are both `Effect` programs; the
 * handler bridges them to Hono's stream API via a `ServerRuntime`.
 */
import { Effect, Fiber, Layer, Queue } from "effect";
import type { EventRow } from "@cognit/db";
import { EventBus } from "./bus.js";
import { listRecentAcrossProjectE } from "./event-queries.js";
import type { ServerRuntime } from "./routes/sessions.js";

export interface SseOptions {
  /** Project id to scope the replay query. */
  readonly projectId: string;
  /** How many recent events to replay before switching to live. */
  readonly replayLimit?: number;
  /** SSE frame name (used as `event:` field). Defaults to "event". */
  readonly eventName?: string;
}

/**
 * Hono handler factory. Returns a `Response` whose body is a
 * `ReadableStream` of SSE frames.
 */
export const sseHandler = (runtime: ServerRuntime, opts: SseOptions) => {
  const replayLimit = opts.replayLimit ?? 50;
  const eventName = opts.eventName ?? "event";
  const projectId = opts.projectId;

  return async (): Promise<Response> => {
    const encoder = new TextEncoder();
    const format = (row: EventRow) =>
      encoder.encode(`event: ${eventName}\ndata: ${JSON.stringify(row)}\n\n`);

    let cleanup: (() => void) | null = null;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (row: EventRow) => {
          try {
            controller.enqueue(format(row));
          } catch {
            /* stream closed */
          }
        };

        const program = Effect.gen(function* () {
          // Replay tail (project-wide)
          const replay = yield* listRecentAcrossProjectE(projectId, replayLimit);
          for (const r of replay) send(r);
          // Subscribe
          const bus = yield* EventBus;
          const { queue, unsub } = yield* bus.subscribe();
          // Drain loop (runs in fiber)
          const drain = Effect.gen(function* () {
            while (true) {
              const row = yield* Queue.take(queue);
              send(row);
            }
          });
          const fiber = yield* Effect.fork(drain);
          cleanup = () => {
            void runtime.runFork(unsub.pipe(Effect.zipRight(Fiber.interrupt(fiber))));
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
      },
    });
  };
};

/** Unused export kept for symmetry with the runtime pattern. */
export const makeSseRuntime = <R, E>(
  layer: Layer.Layer<R, E, never>,
): Layer.Layer<R, E, never> => layer;
