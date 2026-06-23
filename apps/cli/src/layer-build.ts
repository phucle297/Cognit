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
  parseAgentConfig,
} from "@cognit/agent";
import { LlmLiveLazy } from "@cognit/llm";
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
 * Build an `LlmProvider` Layer from an `AgentConfig`.
 *
 * - `provider: undefined` or `provider: "mock"` → canned stop-only
 *   decision via `@cognit/agent`'s `llmProviderFrom`. The schema
 *   relaxed `provider` to optional in Cognit-l06/005, so callers
 *   that omit the flag land here. `@cognit/llm`'s `modelFor` throws
 *   for `mock` by design, so we cannot route through the real
 *   provider factory — the canned response keeps tests and smoke
 *   runs working without API keys.
 * - Real providers (`anthropic` / `openai` / `google` / `ollama`)
 *   → `@cognit/llm`'s `LlmLiveLazy`. Missing env vars surface as
 *   `LlmCompletionError` on the first call rather than crashing
 *   at process start, so a misconfigured operator gets a usable
 *   error message.
 */
export const buildLlmLayer = (cfg: AgentConfig): Layer.Layer<LlmProvider> => {
  if (cfg.provider === undefined || cfg.provider === "mock") {
    // Mock decision: no actions, no rank overrides, stop=false so
    // the supervisor keeps ticking (tests for `--once` and for the
    // stop sentinel both rely on the loop actually looping). The
    // rationale is informative; ops can see why a tick ran with
    // no decisions.
    return llmProviderFrom(() =>
      Effect.succeed(
        JSON.stringify({
          schema_version: "1",
          rationale: "mock: no LLM available; loop continues without actions",
          actions: [],
          rank_overrides: [],
          stop: false,
        }),
      ),
    );
  }
  return LlmLiveLazy(cfg);
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
    buildLlmLayer(agentCfg),
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
  const fullLayer = buildAppLayerWithAgent(
    root,
    agentCfg,
    policy,
    redactionCfg,
    actorDefaults,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return eff.pipe(Effect.provide(fullLayer)) as any;
};

/**
 * Convenience: parse an `AgentConfig` from partial CLI flags. Accepts
 * `provider` / `model` as overrides; the rest falls back to
 * `defaultAgentConfig`. Throws via `parseAgentConfig` if the input
 * is malformed (e.g. unknown provider).
 */
export const agentConfigFromFlags = (flags: {
  provider?: string;
  model?: string;
}): AgentConfig =>
  parseAgentConfig({
    ...(flags.provider !== undefined ? { provider: flags.provider } : {}),
    ...(flags.model !== undefined ? { model: flags.model } : {}),
  });
