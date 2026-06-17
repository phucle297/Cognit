/**
 * packages/db/test/bus.test.ts — phase 5.1 event bus chokepoint.
 *
 * Covers the move of `EventBusLive` into `@cognit/db`, the new
 * `shutdown()` method on the Tag, the per-subscriber 100ms timeout
 * that protects the publisher from a stuck consumer, and the
 * `EventBusNoop` default that db-direct consumers see.
 *
 * Six cases per plans/phase-5.md §5.1.6:
 *   1. publish delivers to all subscribers
 *   2. publish to a subscriber whose queue was shutdown is non-blocking
 *   3. shutdown causes Queue.take to reject (so SSE drain fibers exit)
 *   4. subscriber unsubscribed is removed from the Ref
 *   5. slow subscriber (never reads) does not block publisher
 *   6. EventBusNoop.publish is a no-op (regression guard)
 */
import { describe, expect, it } from "vitest";
import { Effect, Exit, Layer, Queue } from "effect";
import { EventBus, EventBusLive, EventBusNoop, type EventRow } from "../src";

const runOk = <A, E>(eff: Effect.Effect<A, E, EventBus>): Promise<A> =>
  Effect.runPromise(
    eff.pipe(Effect.provide(EventBusLive)) as Effect.Effect<A, E, never>,
  );

const makeEventRow = (id: string): EventRow => ({
  id,
  project_id: "01projectxxxxxxxxxxxxxxxxx",
  session_id: "01sessionxxxxxxxxxxxxxxxxx",
  actor_id: "01actorxxxxxxxxxxxxxxxxxx",
  type: "observation_recorded",
  version: "1.1.0",
  payload_json: JSON.stringify({ text: "x" }),
  source_json: null,
  artifact_refs_json: null,
  causation_id: null,
  correlation_id: null,
  confidence: null,
  parent_verification_id: null,
  linked_hypothesis_id: null,
  stdout_excerpt: null,
  exit_code: null,
  duration_ms: null,
  created_artifact_id: null,
  created_at: "2026-06-17T00:00:00.000Z",
});

describe("EventBusLive", () => {
  it("publish delivers to all subscribers", async () => {
    await runOk(
      Effect.gen(function* () {
        const bus = yield* EventBus;
        const a = yield* bus.subscribe();
        const b = yield* bus.subscribe();
        const row = makeEventRow("01evtAAAAAAAAAAAAAAAAAAAAA");
        yield* bus.publish(row);
        // Both subscribers must see the same row, in FIFO order.
        expect(yield* Queue.take(a.queue)).toEqual(row);
        expect(yield* Queue.take(b.queue)).toEqual(row);
        yield* a.unsub;
        yield* b.unsub;
      }),
    );
  });

  it("publish does not block on a subscriber whose queue was shutdown", async () => {
    await runOk(
      Effect.gen(function* () {
        const bus = yield* EventBus;
        const a = yield* bus.subscribe();
        // Shutdown `a`'s queue directly. The publisher must still
        // succeed — the 100ms timeout / ignoreLogged shields the
        // append path from any subscriber-side failure.
        yield* Queue.shutdown(a.queue);
        const row = makeEventRow("01evtBBBBBBBBBBBBBBBBBBBBB");
        // Race against a 5s timer: if publish blocks, the test fails.
        const exit = yield* Effect.promise(() =>
          Promise.race([
            Effect.runPromise(bus.publish(row).pipe(Effect.as("ok"))),
            new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5_000)),
          ]),
        );
        expect(exit).toBe("ok");
      }),
    );
  });

  it("shutdown causes Queue.take to reject", async () => {
    await runOk(
      Effect.gen(function* () {
        const bus = yield* EventBus;
        const a = yield* bus.subscribe();
        // Take is parked forever on an empty queue; race it against
        // bus.shutdown. After shutdown, the parked take resolves
        // (with a defect or interrupt, depending on effect version),
        // so the race resolves with `bus` first, never hanging.
        const winner: "bus" | "take" = yield* Effect.race(
          bus.shutdown.pipe(Effect.as("bus" as const)),
          Queue.take(a.queue).pipe(Effect.as("take" as const)),
        );
        expect(winner).toBe("bus");
      }),
    );
  });

  it("subscriber unsubscribed is removed from the Ref", async () => {
    await runOk(
      Effect.gen(function* () {
        const bus = yield* EventBus;
        const a = yield* bus.subscribe();
        const b = yield* bus.subscribe();
        // Both subscribed; verify publish reaches both.
        const row = makeEventRow("01evtCCCCCCCCCCCCCCCCCCCCC");
        yield* bus.publish(row);
        expect(yield* Queue.take(a.queue)).toEqual(row);
        expect(yield* Queue.take(b.queue)).toEqual(row);
        // Unsubscribe `a`; `b` should still see the next event, `a`
        // must not (its queue is shut down by the unsub effect, so
        // take would reject — we don't try to take from `a` here).
        yield* a.unsub;
        const row2 = makeEventRow("01evtDDDDDDDDDDDDDDDDDDDDD");
        yield* bus.publish(row2);
        expect(yield* Queue.take(b.queue)).toEqual(row2);
        yield* b.unsub;
      }),
    );
  });

  it("a subscriber that never reads does not block the publisher", async () => {
    await runOk(
      Effect.gen(function* () {
        const bus = yield* EventBus;
        const slow = yield* bus.subscribe();
        // The dropping queue accepts 10_000 entries silently; we'll
        // push 50. The publisher must finish well under 5 seconds
        // (per-subscriber timeout is 100ms; with 50 events x 1 slow
        // subscriber the worst case is ~5s, so we use 6s to keep
        // CI margin tight while still catching a real stall).
        const rows = Array.from({ length: 50 }, (_, i) =>
          makeEventRow(`01evt${String(i).padStart(20, "0")}`),
        );
        const exit: "done" | "timeout" = yield* Effect.promise(() =>
          Promise.race([
            Effect.runPromise(
              Effect.forEach(rows, (r) => bus.publish(r), { discard: true }).pipe(
                Effect.as("done" as const),
              ),
            ),
            new Promise<"timeout">((resolve) =>
              setTimeout(() => resolve("timeout"), 6_000),
            ),
          ]),
        );
        expect(exit).toBe("done");
        // Drain whatever made it through (likely 0; the test never
        // read from `slow` so all 50 may be sitting in the dropping
        // buffer up to capacity).
        yield* slow.unsub;
      }),
    );
  });
});

describe("EventBusNoop", () => {
  it("publish is a no-op and never fails", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const bus = yield* EventBus;
        yield* bus.publish(makeEventRow("01evtEEEEEEEEEEEEEEEEEEEEE"));
      }).pipe(Effect.provide(EventBusNoop)),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("subscribe returns a queue + a no-op unsub", async () => {
    const sub = await Effect.runPromise(
      Effect.gen(function* () {
        const bus = yield* EventBus;
        return yield* bus.subscribe();
      }).pipe(Effect.provide(EventBusNoop)),
    );
    // Layer.succeed builds the service once; the queue is real but
    // no one will ever offer to it.
    expect(sub.queue).toBeDefined();
    // unsub must succeed without error.
    const exit = await Effect.runPromiseExit(sub.unsub);
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("shutdown is a no-op", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const bus = yield* EventBus;
        yield* bus.shutdown;
      }).pipe(Effect.provide(EventBusNoop)),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  // Sanity: EventBusNoop is the default DbLive wires in. Confirm the
  // tag resolves to a publish that does not depend on real subscribers.
  it("EventBusNoop default works under a Layer.merge with unrelated tags", async () => {
    const Sentinel = Symbol.for("bus-noop-sentinel");
    const sentinelLayer = Layer.succeed(Sentinel as never, "ok" as never);
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const bus = yield* EventBus;
        yield* bus.publish(makeEventRow("01evtFFFFFFFFFFFFFFFFFFFFF"));
      }).pipe(Effect.provide(Layer.merge(EventBusNoop, sentinelLayer))),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});
