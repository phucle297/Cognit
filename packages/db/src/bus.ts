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
 * Production `EventBusLive` (the in-process Ref-based fan-out) lives
 * in `apps/server/src/bus.ts`; it re-exports `EventBus` from here
 * for backward compatibility so existing server-side imports keep
 * working.
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
   */
  readonly subscribe: () => Effect.Effect<
    { queue: Queue.Queue<EventRow>; unsub: Effect.Effect<void, never, never> },
    never,
    never
  >;
}

export class EventBus extends Context.Tag("@cognit/db/EventBus")<
  EventBus,
  EventBusShape
>() {}
