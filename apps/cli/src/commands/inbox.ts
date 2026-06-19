import { Command } from "commander";
import { Effect, Layer } from "effect";
import {
  ActorDefaults,
  ActorDefaultsBuiltIn,
  actorDefaultsLayer,
  drainInbox,
  RedactionConfigDefault,
  runInboxWatcher,
  SessionPolicy,
  sessionPolicyFromConfig,
} from "@cognit/db";
import { findProjectRoot, projectPaths } from "../paths.js";
import { readConfig } from "../yaml-io.js";
import { buildAppLayer } from "../layer-build.js";
import { getOutputMode, emit } from "../output.js";

interface InboxOptions {
  watch?: boolean;
  process?: boolean;
}

const requireProjectRoot = (): string => {
  const root = findProjectRoot();
  if (!root) {
    process.stderr.write("cognit: no .cognit/cognit.yaml found. Run `cognit init` first.\n");
    process.exitCode = 2;
    throw new Error("not in a cognit project");
  }
  return root;
};

/**
 * Read `cognit.yaml` once and derive the inbox watcher config. The
 * `debounceMs` value is sourced from `inbox.debounce_ms` (defaults to
 * 200 per the config schema) so the watcher respects whatever the
 * user configured rather than a hardcoded CLI constant.
 */
const buildInboxConfigFromYaml = async (root: string) => {
  const config = await readConfig(projectPaths(root).config);
  return {
    inboxDir: projectPaths(root).inbox,
    processedDir: `${projectPaths(root).dir}/processed`,
    errorDir: projectPaths(root).inboxError,
    debounceMs: config.inbox.debounce_ms,
  };
};

/**
 * Read `cognit.yaml` once and derive the `SessionPolicy` layer (for
 * the R channel). The watcher reads the policy from the R channel via
 * `SessionService.appendEvent` → `SessionPolicy.everyN`; we don't need
 * to plumb a separate shape through the inbox config.
 */
const loadSessionPolicy = async (root: string): Promise<Layer.Layer<SessionPolicy>> => {
  const config = await readConfig(projectPaths(root).config);
  const shape = sessionPolicyFromConfig(config);
  return Layer.succeed(SessionPolicy)(shape);
};

/**
 * Read `cognit.yaml` once and derive the `ActorDefaults` layer. The
 * DB layer (`ensureActor`) reads defaults off the R channel rather
 * than a hardcoded literal — Phase 9.1 closes AC 9.1.3. Built-ins
 * are the fallback if the config omits the relevant keys.
 */
const loadActorDefaults = async (root: string): Promise<Layer.Layer<ActorDefaults>> => {
  const config = await readConfig(projectPaths(root).config);
  return actorDefaultsLayer({
    human: config.actors.defaults.human ?? ActorDefaultsBuiltIn.human,
    worker: config.actors.defaults.worker ?? ActorDefaultsBuiltIn.worker,
    system: config.actors.defaults.system ?? ActorDefaultsBuiltIn.system,
  });
};

const runInboxCommand = <A, E, R>(
  root: string,
  policy: Layer.Layer<SessionPolicy>,
  actorDefaults: Layer.Layer<ActorDefaults>,
  eff: Effect.Effect<A, E, R>,
): Promise<A> => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const provided = Effect.provide(eff, buildAppLayer(root, policy, RedactionConfigDefault, actorDefaults)) as any as Effect.Effect<
    A,
    E,
    never
  >;
  return Effect.runPromise(provided).catch((e: unknown) => {
    if (process.exitCode === undefined) process.exitCode = 1;
    process.stderr.write(`cognit: ${(e as Error).message ?? String(e)}\n`);
    throw e;
  });
};

/**
 * `cognit inbox --watch` — start a chokidar watcher (long-running).
 * `cognit inbox --process` — drain the current inbox once.
 *
 * Both paths read `cognit.yaml` once at command entry so the
 * snapshot policy travels with every append. Reading is async, so
 * this action is `async` end-to-end.
 */
export function registerInbox(program: Command): void {
  program
    .command("inbox")
    .description("watch or process the local inbox (.cognit/inbox/)")
    .option("--watch", "start a long-running chokidar watcher")
    .option("--process", "drain the inbox queue once and exit")
    .action(async (opts: InboxOptions) => {
      const root = requireProjectRoot();
      if (!opts.watch && !opts.process) {
        process.stderr.write("cognit: inbox requires --watch or --process\n");
        process.exitCode = 2;
        return;
      }
      const policy = await loadSessionPolicy(root);
      const actorDefaults = await loadActorDefaults(root);
      const config = await buildInboxConfigFromYaml(root);
      if (opts.process) {
        const result = await runInboxCommand(
          root,
          policy,
          actorDefaults,
          Effect.gen(function* () {
            return yield* drainInbox(config);
          }),
        );
        if (getOutputMode() === "json") {
          emit("json", "inbox", {
            processed: result.processed,
            errored: result.errored,
          });
          return;
        }
        process.stdout.write(`processed: ${result.processed}\n`);
        process.stdout.write(`errored:   ${result.errored}\n`);
        return;
      }
      if (opts.watch) {
        await runInboxCommand(
          root,
          policy,
          actorDefaults,
          Effect.gen(function* () {
            const watcher = yield* runInboxWatcher(config);
            // Long-running. Block forever; SIGTERM/SIGINT kill the
            // process. The Effect returns immediately after the
            // chokidar watcher is wired up, so we attach a never-
            // resolving promise to keep the process alive.
            void watcher;
            yield* Effect.never;
          }),
        );
      }
    });
}
