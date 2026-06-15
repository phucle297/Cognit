/**
 * apps/server/src/bus.ts — typed in-process event bus for SSE.
 *
 * `EventBus` is a single publisher / multi-subscriber channel that
 * `SessionService.appendEvent` (and the inbox watcher, via the same
 * appendEvent path) push into after a successful insert. SSE
 * subscribers receive the row and forward it as a `data:` frame.
 *
 * Subscribers are push-based via the `subscribe` callback. The
 * bus is in-process and per-server-instance — restarting the
 * server drops in-flight subscriptions (replay-then-live is the
 * caller's job; see `sse.ts`).
 *
 * Bus state is held inside the `EventBus` service. There is no
 * cross-process fan-out (that's a phase 4 / v0.2 item).
 */
import { Context, Effect, Layer, Queue, Ref } from "effect";
import type { EventRow } from "@cognit/db";

export interface EventBusShape {
  /** Publish a freshly-inserted event row to all subscribers. */
  readonly publish: (row: EventRow) => Effect.Effect<void, never, never>;
  /**
   * Subscribe to event rows. Returns:
   *  - a queue that the subscriber drains, and
   *  - an `unsub` effect to remove the subscription.
   */
  readonly subscribe: () => Effect.Effect<
    { queue: Queue.Queue<EventRow>; unsub: Effect.Effect<void, never, never> },
    never,
    never
  >;
}

export class EventBus extends Context.Tag("@cognit/server/EventBus")<
  EventBus,
  EventBusShape
>() {}

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

    return { publish, subscribe } satisfies EventBusShape;
  }),
);
