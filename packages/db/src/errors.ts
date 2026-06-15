import { Data, Effect } from "effect";

/**
 * Tagged error types. Effect catches these via `catchTag`.
 * All errors are `Data.Case` so they are equal-by-value (no stack trace
 * captured automatically — these are domain errors, not programmer errors).
 */

export class DbError extends Data.TaggedError("DbError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class DbCorrupted extends Data.TaggedError("DbCorrupted")<{
  readonly message: string;
  readonly integrityCheck: string;
}> {}

export class MigrationVersionMismatch extends Data.TaggedError("MigrationVersionMismatch")<{
  readonly applied: string;
  readonly file: string;
}> {}

export class UnknownEventType extends Data.TaggedError("UnknownEventType")<{
  readonly type: string;
  readonly knownTypes: ReadonlyArray<string>;
}> {}

export class UnknownEventVersion extends Data.TaggedError("UnknownEventVersion")<{
  readonly type: string;
  readonly version: string;
  readonly knownVersions: ReadonlyArray<string>;
}> {}

export class ValidationFailure extends Data.TaggedError("ValidationFailure")<{
  readonly type: string;
  readonly version: string;
  readonly issues: string;
}> {}

export class UnknownSession extends Data.TaggedError("UnknownSession")<{
  readonly sessionId: string;
}> {}

export class SessionClosed extends Data.TaggedError("SessionClosed")<{
  readonly sessionId: string;
}> {}

export class DuplicateEventId extends Data.TaggedError("DuplicateEventId")<{
  readonly id: string;
}> {}

export class MigrationTransformError extends Data.TaggedError("MigrationTransformError")<{
  readonly from: string;
  readonly to: string;
  readonly message: string;
}> {}

export class InboxError extends Data.TaggedError("InboxError")<{
  readonly file: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Phase 3c: emitted by `SessionService.appendEvent` when a constraint
 * rule's `block` action fires. The chokepoint catches this and the
 * caller (CLI / 3d route / inbox watcher) surfaces the rule id +
 * reason to the user.
 */
export class ConstraintViolation extends Data.TaggedError("ConstraintViolation")<{
  readonly ruleId: string;
  readonly reason: string;
  readonly eventType: string;
  readonly sessionId: string;
}> {}

export type AppendError =
  | UnknownEventType
  | UnknownEventVersion
  | ValidationFailure
  | UnknownSession
  | SessionClosed
  | ConstraintViolation
  | DbError;

export type ReadError = DbError | NotFound;

export class NotFound extends Data.TaggedError("NotFound")<{
  readonly entity: "event" | "session" | "actor" | "project";
  readonly id: string;
}> {}

/**
 * Re-raise a synchronous throwable as an Effect. Used at the boundary where
 * the underlying driver throws (better-sqlite3, fs).
 */
export const tryPromise = <A, E>(
  thunk: () => Promise<A>,
  onError: (e: unknown) => E,
): Effect.Effect<A, E> =>
  Effect.tryPromise({
    try: thunk,
    catch: onError,
  });

export const trySync = <A, E>(thunk: () => A, onError: (e: unknown) => E): Effect.Effect<A, E> =>
  Effect.try({
    try: thunk,
    catch: onError,
  });
