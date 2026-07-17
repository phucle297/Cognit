import { Effect, Layer } from "effect";
import {
  ActorDefaults,
  ActorDefaultsBuiltIn,
  actorDefaultsLayer,
  ArtifactRepo,
  DbConnection,
  DbError,
  DbCorrupted,
  DbLive,
  DbSize,
  EventBus,
  EventBusNoop,
  EventStore,
  Logger,
  LoggerNoop,
  ProjectService,
  RawEventStore,
  SessionPolicy,
  SessionPolicyDefault,
  SessionService,
  SnapshotService,
  Redactor,
  RedactionConfig,
  RedactionConfigDefault,
  MigrationRegistry,
  Uuid,
  UuidLive,
  CognitionService,
} from "@cognit/db";
import {
  AgentConfig,
  LlmCompletionError,
  LlmProvider,
  llmProviderFrom,
} from "@cognit/agent";
import { LlmLive } from "@cognit/llm";
import type { LlmConfig } from "@cognit/core";
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
  | RawEventStore
  | Logger
  | Redactor
  | RedactionConfig
  | MigrationRegistry
  | DbSize
  | ArtifactRepo
  | Uuid
  | ActorDefaults
  | EventBus
  | LlmProvider;

/**
 * The full Layer for a given project root. DbLive composes
 * DbConnection + EventStore + SessionService + SnapshotService +
 * ProjectService. We merge `LoggerNoop` and `EventBusNoop` so the
 * resulting Layer is usable as-is by commands that don't wire a
 * structured logger or a real bus. (`EventBus` enters the R-channel
 * of `SessionService` in phase 5.1; the CLI never subscribes, so
 * `EventBusNoop` is the right default here.)
 */
export type AppLayer = Layer.Layer<AppServices, DbError | DbCorrupted, never>;

/**
 * Build the full app Layer for a given project root. The DB path is
 * derived from the standard `.cognit/cognit.db` layout under `root`.
 *
 * The optional `policy` lets callers inject a `SessionPolicy` (e.g.
 * one derived from `cognit.yaml`). When omitted, the default
 * `{ everyN: 100, forkOnResume: true }` policy is used.
 *
 * The optional `redactionConfig` lets callers inject a
 * `RedactionConfig` carrying user patterns from
 * `cognit.yaml::redaction.patterns`. When omitted, no user patterns
 * are merged (built-ins only).
 */
export const buildAppLayer = (
  root: string,
  policy: Layer.Layer<SessionPolicy> = SessionPolicyDefault,
  redactionConfig: Layer.Layer<RedactionConfig> = RedactionConfigDefault,
  actorDefaults: Layer.Layer<ActorDefaults> = actorDefaultsLayer(ActorDefaultsBuiltIn),
): AppLayer => Layer.provideMerge(
  Layer.provideMerge(
    Layer.merge(
      DbLive(root + "/.cognit/cognit.db", policy, redactionConfig),
      LoggerNoop,
    ),
    actorDefaults,
  ),
  EventBusNoop,
) as AppLayer;

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
 * `SessionPolicy` from the `session` section AND a `RedactionConfig`
 * from the `redaction` section, then provides both into the app
 * layer. Used by CLI commands that need the policy as a value (e.g.
 * to pass into `drainInbox({ ..., policy })`) and by the redaction
 * test CLI.
 *
 * `withAppLayer` stays sync for backwards compatibility — commands
 * that don't care about the policy / user patterns keep its simple
 * shape.
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
  // User-supplied redaction patterns from cognit.yaml. The default
  // `cognit.yaml` produced by `cognit init` has `redaction.patterns: []`,
  // so most projects end up with the built-ins only. Malformed
  // regexes are caught by `makeRedactor` at construction time; the
  // redaction test CLI catches the throw and reports a clean error.
  const redactionCfg: Layer.Layer<RedactionConfig> = Layer.succeed(RedactionConfig)({
    userPatterns: config.redaction.patterns,
  });
  // Per-type actor trust defaults from cognit.yaml →
  // actors.defaults.<type>. Falls back to built-ins when the key is
  // absent (the config schema guarantees the values via
  // `optionalWith(..., { default: () => ... })`).
  const actorDefaults: Layer.Layer<ActorDefaults> = actorDefaultsLayer({
    human: config.actors.defaults.human,
    worker: config.actors.defaults.worker,
    system: config.actors.defaults.system,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return eff.pipe(
    Effect.provide(buildAppLayer(root, policy, redactionCfg, actorDefaults)),
  ) as any;
};

/**
 * Build an `LlmProvider` Layer from an `AgentConfig` + `LlmConfig`.
 *
 * Routing:
 *
 * - `cfg.model === "mock-1"` (the default) → canned stop-only
 *   decision via `@cognit/agent`'s `llmProviderFrom`. No proxy,
 *   no API key. Lets `cognit init` + `cognit agent run --once`
 *   work in smoke runs and CI without configuration.
 * - Any other model id → LiteLLM-proxy route via
 *   `LlmLive(llm)`. The supervisor loop passes the resolved model
 *   id per call (alias/literal resolved upstream via
 *   `resolveModel`). Boot check verifies
 *   `process.env[llm.api_key_env]` is present at build time and
 *   throws `LlmCompletionError` with the exact var name when
 *   missing — the supervisor catches the throw via
 *   `withAppLayerAndConfigAndAgent` and surfaces it cleanly.
 *
 * Mock detection keys off the model id (`mock-1`), not a separate
 * provider literal — the `--provider` flag and the
 * `agent.provider` config field were removed.
 */
export const buildLlmLayer = (
  cfg: AgentConfig,
  llm: LlmConfig,
): Layer.Layer<LlmProvider> => {
  if (cfg.model === "mock-1") {
    // Mock decision: no actions, no rank overrides, stop=false so
    // the supervisor keeps ticking (tests for `--once` and for the
    // stop sentinel both rely on the loop actually looping). The
    // rationale is informative; ops can see why a tick ran with
    // no decisions.
    return llmProviderFrom(() =>
      Effect.succeed(
        JSON.stringify({
          schema_version: "1",
          rationale: "mock-1: canned layer, loop continues without actions",
          actions: [],
          rank_overrides: [],
          stop: false,
        }),
      ),
    );
  }
  // Eager boot check at build time. Throws LlmCompletionError with
  // the exact env var name (matches the schema's `llm.api_key_env`).
  // The CLI surfaces the throw via `withAppLayerAndConfigAndAgent`'s
  // catch block so the operator sees a clean stderr message + exit 1
  // before any tick runs.
  return LlmLive(llm);
};

/**
 * Compose `buildAppLayer` with an `LlmProvider` Layer so callers
 * that need the supervisor loop can `Effect.provide` everything in
 * one shot. The merge keeps `AppLayer`'s error channel unchanged
 * (`DbError | DbCorrupted`) — the LLM layer does not add to it;
 * runtime failures surface as `LlmCompletionError` etc. on the
 * Effect's error channel, not the Layer's.
 */
export const buildAppLayerWithAgent = (
  root: string,
  agentCfg: AgentConfig,
  llm: LlmConfig,
  policy: Layer.Layer<SessionPolicy> = SessionPolicyDefault,
  redactionConfig: Layer.Layer<RedactionConfig> = RedactionConfigDefault,
  actorDefaults: Layer.Layer<ActorDefaults> = actorDefaultsLayer(ActorDefaultsBuiltIn),
): Layer.Layer<AppServices, DbError | DbCorrupted | LlmCompletionError, never> =>
  // `runTick` (in @cognit/agent) requires Uuid in its R-channel for
  // auto-generating tick ids. `DbLive` uses `UuidLive` internally
  // but does NOT expose `Uuid` in its public output set. We merge
  // `UuidLive` here so the supervisor loop can find it at runtime.
  Layer.merge(
    Layer.provideMerge(
      buildAppLayer(root, policy, redactionConfig, actorDefaults),
      UuidLive,
    ),
    buildLlmLayer(agentCfg, llm),
  ) as Layer.Layer<AppServices, DbError | DbCorrupted | LlmCompletionError, never>;

/**
 * Async variant — reads `cognit.yaml`, derives `SessionPolicy` /
 * `RedactionConfig` / `ActorDefaults`, AND composes the LLM layer.
 * Use this from `cognit agent run` (which needs all three).
 *
 * The merged error channel includes `LlmCompletionError` so the
 * caller can catch missing-env failures cleanly.
 */
export const withAppLayerAndConfigAndAgent = async <A, E, R>(
  root: string,
  eff: Effect.Effect<A, E, R>,
  agentCfg: AgentConfig,
): Promise<Effect.Effect<A, E | LlmCompletionError, Exclude<R, AppServices>>> => {
  const config = await readConfig(projectPaths(root).config);
  const policy: Layer.Layer<SessionPolicy> = Layer.succeed(SessionPolicy)({
    everyN: config.session.snapshot_every_n_events,
    forkOnResume: config.session.fork_on_resume,
  });
  const redactionCfg: Layer.Layer<RedactionConfig> = Layer.succeed(RedactionConfig)({
    userPatterns: config.redaction.patterns,
  });
  const actorDefaults: Layer.Layer<ActorDefaults> = actorDefaultsLayer({
    human: config.actors.defaults.human,
    worker: config.actors.defaults.worker,
    system: config.actors.defaults.system,
  });
  // `llm:` block from cognit.yaml — routed through
  // `LlmLive` in `buildLlmLayer` when
  // `agentCfg.model !== "mock-1"`. Reading the block here (instead
  // of re-reading inside the layer) keeps the "no model configured"
  // error path visible to the CLI so we can surface a clean stderr
  // message before the first tick.
  const fullLayer = buildAppLayerWithAgent(
    root,
    agentCfg,
    config.llm,
    policy,
    redactionCfg,
    actorDefaults,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return eff.pipe(Effect.provide(fullLayer)) as any;
};
