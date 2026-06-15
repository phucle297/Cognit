/**
 * apps/server/src/bus.ts — production `EventBus` layer.
 *
 * Re-exports the `EventBus` Tag from `@cognit/db` for backward
 * compatibility — server-side routes and tests import `EventBus`
 * from here, but the interface itself lives in the db package so
 * the db-side `EventBusNoop` default can type-check against the
 * same contract.
 *
 * `EventBusLive` is the in-process Ref-based fan-out used by the
 * server: `publish` notifies every active subscriber's queue,
 * `subscribe` returns a new queue + an `unsub` that drops the
 * subscriber and shuts the queue down.
 *
 * Subscribers are push-based via the `subscribe` callback. The
 * bus is in-process and per-server-instance — restarting the
 * server drops in-flight subscriptions (replay-then-live is the
 * caller's job; see `sse.ts`).
 *
 * Bus state is held inside the `EventBus` service. There is no
 * cross-process fan-out (that's a phase 4 / v0.2 item).
 */
export { EventBus, type EventBusShape } from "@cognit/db";
import { Effect, Layer, Queue, Ref } from "effect";
import type { EventRow } from "@cognit/db";
import { EventBus } from "@cognit/db";

export const EventBusLive: Layer.Layer<EventBus, never, never> = Layer.effect(
  EventBus,
  Effect.gen(function* () {
    const subsRef = yield* Ref.make<ReadonlyArray<Queue.Queue<EventRow>>>([]);

    const publish = (row: EventRow) =>
      Effect.gen(function* () {
        const subs: ReadonlyArray<Queue.Queue<EventRow>> = yield* Ref.get(subsRef);
        yield* Effect.forEach(subs, (q: Queue.Queue<EventRow>) => Queue.offer(q, row), {
          discard: true,
        });
      });

    const subscribe = () =>
      Effect.gen(function* () {
        const q = yield* Queue.unbounded<EventRow>();
        yield* Ref.update(subsRef, (s: ReadonlyArray<Queue.Queue<EventRow>>) => [...s, q]);
        const unsub: Effect.Effect<void, never, never> = Ref.update(
          subsRef,
          (s: ReadonlyArray<Queue.Queue<EventRow>>) => s.filter((x) => x !== q),
        ).pipe(Effect.tap(() => Queue.shutdown(q)));
        return { queue: q, unsub };
      });

    return { publish, subscribe };
  }),
);
