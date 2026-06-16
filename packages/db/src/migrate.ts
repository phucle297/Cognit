import { Effect, Either, Layer, Schema } from "effect";
import { MigrationRegistry } from "./context";
import {
  PAYLOAD_SCHEMAS_BY_VERSION,
  PAYLOAD_SCHEMAS_V1_1_0,
} from "./event-schema";
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
 * `transformsFor(from, to)` to lift a payload.
 *
 * v1.0.0 -> v1.1.0 is an identity transform for all event types —
 * the v1.1.0 schemas are a strict superset (all new fields optional
 * with `null` defaults). Registered explicitly so the migration
 * runner can prove the path exists and `migratePayload` can pick
 * the right per-version schema for re-validation.
 */
const TRANSFORMS: ReadonlyArray<Transform> = [
  {
    from: "1.0.0",
    to: "1.1.0",
    fn: (payload) => payload,
  },
];

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
    knownVersions: () => Object.keys(PAYLOAD_SCHEMAS_BY_VERSION),
  },
);

/**
 * Pick the schema map for a target version. Falls back to the
 * current v1.1.0 map for unknown versions — the schema-validation
 * step that follows is the authoritative "this shape is not allowed"
 * signal, so a forward-default is safe.
 */
const schemaMapFor = (version: string): Readonly<Record<string, Schema.Schema<any, any, never>>> =>
  PAYLOAD_SCHEMAS_BY_VERSION[version] ?? PAYLOAD_SCHEMAS_V1_1_0;

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
        schemaMapFor(toVersion)[type] as Schema.Schema<any, any, never>,
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
      schemaMapFor(toVersion)[type] as Schema.Schema<any, any, never>,
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
