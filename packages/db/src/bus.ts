/**
 * packages/db/src/bus.ts — typed in-process event bus interface.
 *
 * `EventBus` is a single publisher / multi-subscriber channel that
 * `SessionService.appendEvent` (and the inbox watcher, via the same
 * appendEvent path) push into after a successful insert. SSE
 * subscribers receive the row and forward it as a `data:` frame.
 *
 * The interface lives in `@cognit/db` so the db package can wire its
 * own no-op default (`EventBusNoop`) into `DbLive`, keeping db-direct
 * consumers (CLI, tests) from needing a real bus implementation.
 *
 * Production `EventBusLive` (the in-process Ref-based fan-out) also
 * lives in `@cognit/db` (`./bus-live`); `apps/server/src/bus.ts` is
 * a re-export shim for backward compatibility.
 *
 * Bus state is held inside the `EventBus` service. There is no
 * cross-process fan-out (that's a phase 4 / v0.2 item).
 */
import { Context, Effect, Queue } from "effect";
import type { EventRow } from "./event-store";

export interface EventBusShape {
  /** Publish a freshly-inserted event row to all subscribers. */
  readonly publish: (row: EventRow) => Effect.Effect<void, never, never>;
  /**
   * Subscribe to event rows. Returns:
   *  - a queue that the subscriber drains, and
   *  - an `unsub` effect to remove the subscription.
   *
   * Errors are typed `unknown` (not `never`) so the SSE handler's
   * `Effect.catchAllCause` in `apps/server/src/sse.ts` can observe
   * subscribe failures — DB init errors, queue creation races, etc.
   * The no-op default (`EventBusNoop`) and the production
   * `EventBusLive` both succeed; the `unknown` channel exists for
   * defensive boundaries, not as a frequent failure mode.
   */
  readonly subscribe: () => Effect.Effect<
    { queue: Queue.Queue<EventRow>; unsub: Effect.Effect<void, never, never> },
    unknown,
    never
  >;
  /**
   * Shut down every active subscriber queue. After `shutdown`, any
   * fiber blocked on `Queue.take` will reject with a defect, so
   * long-running drain fibers (e.g. the SSE loop) can observe
   * termination and close the response stream on SIGTERM.
   * Idempotent: calling twice is a no-op.
   */
  readonly shutdown: Effect.Effect<void, never, never>;
}

export class EventBus extends Context.Tag("@cognit/db/EventBus")<
  EventBus,
  EventBusShape
>() {}
