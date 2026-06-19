import { Context, Layer } from "effect";
import type { ActorType } from "./actor";

/**
 * Per-type default trust score, sourced from `cognit.yaml →
 * actors.defaults.<type>` when the config is loaded; falls back to
 * the built-in defaults when absent.
 *
 * Replaces the hardcoded `DEFAULT_TRUST_BY_TYPE` literal that
 * `ensureActor` used to read. Pulled off the R-channel so unit tests
 * can inject a fixed shape without touching the filesystem.
 */
export type ActorDefaultsShape = Readonly<Record<ActorType, number>>;

export class ActorDefaults extends Context.Tag("@cognit/db/ActorDefaults")<
  ActorDefaults,
  ActorDefaultsShape
>() {}

/**
 * Built-in defaults. Used when `cognit.yaml` is absent, malformed, or
 * omits the relevant key. Matches the historical
 * `DEFAULT_TRUST_BY_TYPE` literal so behaviour is preserved for
 * projects that never customised the values.
 */
export const ActorDefaultsBuiltIn: ActorDefaultsShape = {
  human: 0.9,
  worker: 0.6,
  system: 1.0,
};

/**
 * Build a Layer from a plain `{ human, worker, system }` map. Used by
 * the CLI loader (`apps/cli/src/commands/inbox.ts`) and by tests.
 *
 * Type narrowed against `ActorType` so an unknown type fails at
 * compile time.
 */
export const actorDefaultsLayer = (defaults: ActorDefaultsShape): Layer.Layer<ActorDefaults> =>
  Layer.succeed(ActorDefaults)(defaults);
