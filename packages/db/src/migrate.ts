import { Effect, Either, Layer, Schema } from "effect";
import { MigrationRegistry } from "./context";
import { CURRENT_VERSION, PAYLOAD_SCHEMAS_V1 } from "./event-schema";
import { MigrationTransformError, ValidationFailure } from "./errors";
import { semverGte, semverCompare } from "./semver";

/**
 * A single version transform: when an event is read with payload
 * version `from`, apply `fn` to get a payload at version `to`.
 *
 * `fn` is pure. No DB, no clock, no I/O. That keeps the migration
 * layer testable and replay-deterministic.
 */
export interface Transform {
  readonly from: string;
  readonly to: string;
  readonly type?: string; // if set, only applies to this event type
  readonly fn: (payload: unknown) => unknown;
}

/**
 * The registry: ordered list of transforms. The runner walks
 * `transformsFor(from, CURRENT_VERSION)` to lift a payload.
 *
 * No transforms registered yet (we are at v1.0.0). The infrastructure
 * is in place so a v1.1.0 change is a one-line addition + a test.
 *
 * To add a v1.0.0 -> v1.1.0 transform for `hypothesis_created`, prepend
 * to the list. The runner picks it up automatically.
 */
const TRANSFORMS: ReadonlyArray<Transform> = [];

/** Live layer. */
export const MigrationRegistryLive: Layer.Layer<MigrationRegistry> = Layer.succeed(
  MigrationRegistry,
  {
    transformsFor: (from, to) => {
      if (from === to) return [];
      if (!semverGte(to, from)) {
        return [];
      }
      return TRANSFORMS.filter((t) => semverGte(t.to, to) && semverGte(t.from, from));
    },
    knownVersions: () => [CURRENT_VERSION],
  },
);

/**
 * Lift a stored payload to `target` version by walking transforms.
 * Re-validates the result with the target version's Schema.
 *
 * Returns the migrated + validated payload. Throws MigrationTransformError
 * when no path exists, ValidationFailure when the migrated shape no longer
 * matches the target schema.
 */
export const migratePayload = (
  type: string,
  fromVersion: string,
  toVersion: string,
  payload: unknown,
  transformsFor: (from: string, to: string) => ReadonlyArray<Transform>,
): Effect.Effect<unknown, MigrationTransformError | ValidationFailure> =>
  Effect.gen(function* () {
    if (fromVersion === toVersion) {
      const result = Schema.decodeUnknownEither(
        PAYLOAD_SCHEMAS_V1[type] as Schema.Schema<any, any, never>,
      )(payload);
      if (Either.isLeft(result)) {
        return yield* Effect.fail(
          new ValidationFailure({
            type,
            version: toVersion,
            issues: String(result.left),
          }),
        );
      }
      return result.right;
    }
    const path = transformsFor(fromVersion, toVersion)
      .slice()
      .sort((a, b) => semverCompare(a.from, b.from));
    if (path.length === 0) {
      return yield* Effect.fail(
        new MigrationTransformError({
          from: fromVersion,
          to: toVersion,
          message: `no transform path from ${fromVersion} to ${toVersion}`,
        }),
      );
    }
    let current: unknown = payload;
    for (const t of path) {
      if (t.type && t.type !== type) continue;
      current = t.fn(current);
    }
    const result = Schema.decodeUnknownEither(
      PAYLOAD_SCHEMAS_V1[type] as Schema.Schema<any, any, never>,
    )(current);
    if (Either.isLeft(result)) {
      return yield* Effect.fail(
        new ValidationFailure({
          type,
          version: toVersion,
          issues: String(result.left),
        }),
      );
    }
    return result.right;
  });
