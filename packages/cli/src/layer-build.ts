import { Effect, Layer } from "effect";
import {
  DbConnection,
  DbError,
  DbCorrupted,
  DbLive,
  EventStore,
  Logger,
  LoggerNoop,
  ProjectService,
  SessionService,
  SnapshotService,
  Redactor,
  MigrationRegistry,
  Uuid,
} from "@cognit/db";

/**
 * The R-channel services the CLI commands need (session, snapshot).
 * `Logger` is overridden by the structured one in `DbLive`/`LoggerNoop`
 * merge below; we just want the union of all `Context.Tag`s a
 * command might `yield*`.
 */
export type AppServices =
  | DbConnection
  | EventStore
  | SessionService
  | SnapshotService
  | ProjectService
  | Logger
  | Redactor
  | MigrationRegistry
  | Uuid;

/**
 * The full Layer for a given project root. DbLive composes
 * DbConnection + EventStore + SessionService + SnapshotService +
 * ProjectService. We merge `LoggerNoop` so the resulting Layer is
 * usable as-is by commands that don't wire a structured logger.
 */
export type AppLayer = Layer.Layer<AppServices, DbError | DbCorrupted, never>;

/**
 * Build the full app Layer for a given project root. The DB path is
 * derived from the standard `.cognit/cognit.db` layout under `root`.
 */
export const buildAppLayer = (root: string): AppLayer =>
  Layer.merge(DbLive(root + "/.cognit/cognit.db"), LoggerNoop) as AppLayer;

/**
 * Run an Effect that depends on the app layer, providing the layer
 * built from `root`. Sugar so command bodies don't have to repeat
 * the `Effect.provide(buildAppLayer(root))` pattern.
 *
 * The cast is needed because Effect's type inference for `provide`
 * over a Layer whose A is a union of service tags is too strict for
 * the variance we want here. We strip `AppServices` from the caller's
 * R-channel manually so the returned Effect has a useful type.
 */
export const withAppLayer: <A, E, R>(
  root: string,
  eff: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E, Exclude<R, AppServices>> = (<A, E, R>(
  root: string,
  eff: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, AppServices>> => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return eff.pipe(Effect.provide(buildAppLayer(root))) as any;
}) as <A, E, R>(
  root: string,
  eff: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E, Exclude<R, AppServices>>;
