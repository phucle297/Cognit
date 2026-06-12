import { Context, Effect, Layer } from "effect";
import { ulid as ulidImpl } from "ulid";

/**
 * Monotonic ULID generator. Wraps the `ulid` package so the rest of the
 * code can be tested with a deterministic counter.
 */
export class Uuid extends Context.Tag("@cognit/db/Uuid")<
  Uuid,
  { readonly make: () => Effect.Effect<string> }
>() {}

/** Default live layer using the `ulid` package. */
export const UuidLive: Layer.Layer<Uuid> = Layer.succeed(Uuid)({
  make: () => Effect.sync(() => ulidImpl()),
});

let testCounter = 0;
/**
 * Test layer with a counter-based pseudo-ulid. Each call returns
 * `01<counter-padded-to-24>`. Deterministic + ordered.
 */
export const UuidTest: Layer.Layer<Uuid> = Layer.succeed(Uuid)({
  make: () =>
    Effect.sync(() => {
      testCounter += 1;
      return `01${testCounter.toString(36).padStart(24, "0")}`;
    }),
});

export const resetUuidTestCounter = (): void => {
  testCounter = 0;
};
