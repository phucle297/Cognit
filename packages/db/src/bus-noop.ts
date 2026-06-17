/**
 * packages/db/src/bus-noop.ts — no-op default `EventBus` layer.
 *
 * Used by `DbLive` so db-direct consumers (CLI, tests) don't need to
 * bring their own bus implementation. `publish` is a no-op (no
 * subscribers, so it's free), `subscribe` returns a real but empty
 * `Queue` plus a no-op `unsub` (the queue is never offered to, so
 * it stays empty and `take` blocks forever — fine for a default
 * that has no SSE consumers). `shutdown` is a no-op — no subscriber
 * queues were ever created, so there's nothing to tear down.
 *
 * Production consumers (apps/server) override this with `EventBusLive`
 * so SSE subscribers actually receive events.
 */
import { Effect, Layer, Queue } from "effect";
import type { EventRow } from "./event-store";
import { EventBus } from "./bus";

export const EventBusNoop: Layer.Layer<EventBus, never, never> = Layer.succeed(
  EventBus,
  {
    publish: (_row: EventRow): Effect.Effect<void, never, never> => Effect.void,
    subscribe: () =>
      Effect.gen(function* () {
        const q: Queue.Queue<EventRow> = yield* Queue.unbounded<EventRow>();
        const unsub: Effect.Effect<void, never, never> = Effect.void;
        return { queue: q, unsub };
      }),
    shutdown: Effect.void,
  },
);
