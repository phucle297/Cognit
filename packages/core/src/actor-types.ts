/**
 * Canonical actor-type tuple + union — single source of truth.
 *
 * CLI commands used to redeclare `VALID_ACTOR_TYPES = new Set<ActorType>(["human", "worker", "system"])`
 * inline in 14 files. The string literals are now driven by this tuple
 * so the set of valid actor types can only be edited in one place.
 *
 * The tuple is `as const`; the `ACTOR_TYPE` union is its element type.
 * Consumers should build their `ReadonlySet` via `new Set<ActorType>(ACTOR_TYPES)`.
 */

/** Tuple of every valid actor type. */
export const ACTOR_TYPES = ["human", "worker", "system"] as const;

/** Union of every valid actor type. */
export type ActorType = (typeof ACTOR_TYPES)[number];

/** Canonical set of every valid actor type — single source of truth.
 *  CLI commands import this directly instead of redeclaring locally. */
export const VALID_ACTOR_TYPES: ReadonlySet<ActorType> = new Set<ActorType>(ACTOR_TYPES);
