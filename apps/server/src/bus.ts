/**
 * apps/server/src/bus.ts — re-export shim.
 *
 * The `EventBus` Tag + `EventBusLive` production layer both live in
 * `@cognit/db` (see `packages/db/src/bus.ts` and `bus-live.ts`).
 * Server-side imports pull them through this file for backward
 * compatibility with code paths written before the move in phase 5.1.
 *
 * If you need a real bus (SSE, anything that subscribes), pass
 * `EventBusLive` at the app boundary via `Layer.merge(EventBusLive, ...)`.
 * `DbLive`'s default `EventBusNoop` is sufficient for db-direct
 * consumers that only publish.
 */
export { EventBus, EventBusLive, type EventBusShape, type SubscriberHandle } from "@cognit/db";
