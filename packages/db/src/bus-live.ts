/**
 * packages/db/src/bus-live.ts — production `EventBus` layer.
 *
 * In-process Ref-based fan-out: `publish` notifies every active
 * subscriber's queue, `subscribe` returns a new queue + an `unsub`
 * that drops the subscriber and shuts the queue down. `shutdown`
 * tears down every active subscriber queue so drain fibers blocked
 * on `Queue.take` observe a defect and can exit cleanly on SIGTERM.
 *
 * Per-subscriber queue: `Queue.dropping(10_000)` — bounded so a slow
 * consumer cannot OOM the process; "dropping" so a backed-up
 * subscriber silently loses the oldest event rather than blocking the
 * publisher. Publisher-side safety: `publish` wraps each `offer` in
 * `Effect.timeout(100ms)` and `Effect.ignoreLogged`, so a subscriber
 * whose internal lock is contended (e.g. the queue was just shut
 * down by `shutdown` while another fiber was in `take`) cannot stall
 * the append path. The bus is observability, not a system of record
 * — a dropped or timed-out frame is acceptable, a stalled publisher
 * is not.
 *
 * Bus state is held inside the `EventBus` service. There is no
 * cross-process fan-out (that's a phase 4 / v0.2 item).
 */
import { Effect, Layer, Queue, Ref } from "effect";
import type { EventRow } from "./event-store";
import { EventBus } from "./bus";

interface SubscriberHandle {
  readonly queue: Queue.Queue<EventRow>;
  readonly unsub: Effect.Effect<void, never, never>;
}

export type { SubscriberHandle };

const PER_SUBSCRIBER_TIMEOUT_MS = 100;
const SUBSCRIBER_QUEUE_CAPACITY = 10_000;

export const EventBusLive: Layer.Layer<EventBus, never, never> = Layer.effect(
  EventBus,
  Effect.gen(function* () {
    const subsRef = yield* Ref.make<ReadonlyArray<SubscriberHandle>>([]);

    const publish = (row: EventRow) =>
      Effect.gen(function* () {
        const subs: ReadonlyArray<SubscriberHandle> = yield* Ref.get(subsRef);
        yield* Effect.forEach(
          subs,
          (s) =>
            Queue.offer(s.queue, row).pipe(
              Effect.timeout(`${PER_SUBSCRIBER_TIMEOUT_MS} millis`),
              Effect.ignoreLogged,
            ),
          { discard: true },
        );
      });

    const subscribe = () =>
      Effect.gen(function* () {
        const q = yield* Queue.dropping<EventRow>(SUBSCRIBER_QUEUE_CAPACITY);
        const handle: SubscriberHandle = {
          queue: q,
          unsub: Ref.update(subsRef, (xs) => xs.filter((x) => x.queue !== q)).pipe(
            Effect.tap(() => Queue.shutdown(q)),
          ),
        };
        yield* Ref.update(subsRef, (xs) => [...xs, handle]);
        return { queue: q, unsub: handle.unsub };
      });

    const shutdown = Effect.gen(function* () {
      const subs: ReadonlyArray<SubscriberHandle> = yield* Ref.get(subsRef);
      yield* Effect.forEach(subs, (s) => Queue.shutdown(s.queue), { discard: true });
      yield* Ref.set(subsRef, []);
    });

    return { publish, subscribe, shutdown };
  }),
);
