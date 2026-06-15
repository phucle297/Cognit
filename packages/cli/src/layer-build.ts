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
  SessionPolicy,
  SessionPolicyDefault,
  SessionService,
  SnapshotService,
  Redactor,
  MigrationRegistry,
  Uuid,
  CognitionService,
} from "@cognit/db";
import { readConfig } from "./yaml-io.js";
import { projectPaths } from "./paths.js";

/**
 * The R-channel services the CLI commands need (session, snapshot).
 * `Logger` is overridden by the structured one in `DbLive`/`LoggerNoop`
 * merge below; we just want the union of all `Context.Tag`s a
 * command might `yield*`.
 *
 * `SessionPolicy` is listed so `withAppLayer` strips it from the
 * caller's R-channel when the layer is provided internally. Callers
 * that need the policy as a value (e.g. to pass into
 * `drainInbox(policy)`) should yield it explicitly.
 */
export type AppServices =
  | DbConnection
  | EventStore
  | SessionService
  | SessionPolicy
  | SnapshotService
  | ProjectService
  | CognitionService
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
 *
 * The optional `policy` lets callers inject a `SessionPolicy` (e.g.
 * one derived from `cognit.yaml`). When omitted, the default
 * `{ everyN: 100, forkOnResume: true }` policy is used.
 */
export const buildAppLayer = (
  root: string,
  policy: Layer.Layer<SessionPolicy> = SessionPolicyDefault,
): AppLayer => Layer.merge(DbLive(root + "/.cognit/cognit.db", policy), LoggerNoop) as AppLayer;

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

/**
 * Async variant: reads `cognit.yaml` from `root`, derives a
 * `SessionPolicy` from the `session` section, and provides it into
 * the app layer. Used by CLI commands that need the policy as a
 * value (e.g. to pass into `drainInbox({ ..., policy })`).
 *
 * `withAppLayer` stays sync for backwards compatibility — commands
 * that don't care about the policy keep its simple shape.
 *
 * `readConfig` is async (it reads from disk), so this helper is
 * async. The CLI commands already use `await` at the action entry,
 * so awaiting `withAppLayerAndConfig` is a drop-in replacement for
 * `withAppLayer` at call sites that need the policy.
 */
export const withAppLayerAndConfig = async <A, E, R>(
  root: string,
  eff: Effect.Effect<A, E, R>,
): Promise<Effect.Effect<A, E, Exclude<R, AppServices>>> => {
  const config = await readConfig(projectPaths(root).config);
  const policy: Layer.Layer<SessionPolicy> = Layer.succeed(SessionPolicy)({
    everyN: config.session.snapshot_every_n_events,
    forkOnResume: config.session.fork_on_resume,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return eff.pipe(Effect.provide(buildAppLayer(root, policy))) as any;
};
