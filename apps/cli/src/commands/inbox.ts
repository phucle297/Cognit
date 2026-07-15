import { Command } from "commander";
import { Effect, Layer } from "effect";
import {
  ActorDefaults,
  ActorDefaultsBuiltIn,
  actorDefaultsLayer,
  cleanInboxTmp,
  drainInbox,
  ProjectService,
  RedactionConfigDefault,
  reprocessErrorDir,
  runInboxWatcher,
  SessionPolicy,
  sessionPolicyFromConfig,
  inboxFileCounts,
  readLastDrainStamp,
  type InboxWatcherConfig,
} from "@cognit/db";
import { findProjectRoot, projectPaths } from "../paths.js";
import { readConfig } from "../yaml-io.js";
import { buildAppLayer } from "../layer-build.js";
import { getOutputMode, emit } from "../output.js";
import { detectPlatform, generateSystemdUnit, generateLaunchdUnit } from "../supervisor.js";

interface InboxOptions {
  watch?: boolean;
  process?: boolean;
  reprocess?: boolean;
  status?: boolean;
  installWatch?: boolean;
  cleanTmp?: boolean;
  dryRun?: boolean;
  maxAgeDays?: string;
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
 * Read `cognit.yaml` once for the inbox layout + debounce. `projectId`
 * is resolved inside the layer (via `ProjectService.ensure`) since
 * `ingest` needs it to mint a bootstrap session.
 */
const inboxBaseConfig = async (root: string) => {
  const config = await readConfig(projectPaths(root).config);
  return {
    inboxDir: projectPaths(root).inbox,
    processedDir: `${projectPaths(root).dir}/processed`,
    errorDir: projectPaths(root).inboxError,
    debounceMs: config.inbox.debounce_ms,
    projectName: config.project.name,
    projectRoot: root,
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
  const provided = Effect.provide(
    eff,
    buildAppLayer(root, policy, RedactionConfigDefault, actorDefaults),
  ) as any as Effect.Effect<A, E, never>;
  return Effect.runPromise(provided).catch((e: unknown) => {
    if (process.exitCode === undefined) process.exitCode = 1;
    process.stderr.write(`cognit: ${(e as Error).message ?? String(e)}\n`);
    throw e;
  });
};

/**
 * `cognit inbox --watch` — start a chokidar watcher (long-running).
 * `cognit inbox --process` — drain the current inbox once.
 * `cognit inbox --reprocess` — re-run files in inbox/_error/.
 * `cognit inbox --status` / `--install-watch` — observability / supervisor unit.
 * `cognit inbox --clean-tmp` — delete orphan `.tmp` files older than
 *   `cleanup.inbox_tmp_max_age_days` (default 30). Safe for AI callers
 *   (`--json`, no confirm prompt). Optional `--dry-run` / `--max-age-days`.
 *
 * Watch/process paths read `cognit.yaml` once at command entry so the
 * snapshot policy travels with every append. Reading is async, so
 * this action is `async` end-to-end.
 */
export function registerInbox(program: Command): void {
  program
    .command("inbox")
    .description(
      "watch, process, reprocess, status, install-watch, or clean the local inbox (.cognit/inbox/) — see docs/hooks/README.md",
    )
    .option("--watch", "start a long-running chokidar watcher")
    .option("--process", "drain the inbox queue once and exit")
    .option("--reprocess", "re-run every file in inbox/_error/ (salvage after a fix)")
    .option("--status", "show pending/errored counts + last-drain timestamp")
    .option(
      "--install-watch",
      "print a systemd/launchd unit that runs `cognit inbox --watch` (headless/CI)",
    )
    .option(
      "--clean-tmp",
      "remove orphan .tmp files older than cleanup.inbox_tmp_max_age_days (default 30); AI-safe, no confirm",
    )
    .option("--dry-run", "with --clean-tmp: list candidates without deleting")
    .option(
      "--max-age-days <n>",
      "with --clean-tmp: override cleanup.inbox_tmp_max_age_days (0 = all .tmp)",
    )
    .action(async (opts: InboxOptions) => {
      const root = requireProjectRoot();
      if (
        !opts.watch &&
        !opts.process &&
        !opts.reprocess &&
        !opts.status &&
        !opts.installWatch &&
        !opts.cleanTmp
      ) {
        process.stderr.write(
          "cognit: inbox requires one of --watch, --process, --reprocess, --status, --install-watch, --clean-tmp\n",
        );
        process.exitCode = 2;
        return;
      }

      // --clean-tmp does not need the DB layer: pure filesystem janitor.
      if (opts.cleanTmp) {
        const yaml = await readConfig(projectPaths(root).config);
        const maxAgeDays =
          opts.maxAgeDays !== undefined
            ? Number.parseInt(opts.maxAgeDays, 10)
            : yaml.cleanup.inbox_tmp_max_age_days;
        if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0) {
          process.stderr.write(
            "cognit: --max-age-days must be a non-negative integer\n",
          );
          process.exitCode = 2;
          return;
        }
        const dryRun = !!opts.dryRun;
        const result = await Effect.runPromise(
          cleanInboxTmp({
            inboxDir: projectPaths(root).inbox,
            maxAgeDays,
            dryRun,
          }),
        );
        if (getOutputMode() === "json") {
          emit("json", "inbox.clean_tmp", {
            dryRun,
            maxAgeDays,
            scanned: result.scanned,
            removed: result.removed,
            kept: result.kept,
            files: result.files,
          });
          return;
        }
        process.stdout.write(
          `${dryRun ? "would_remove" : "removed"}: ${result.removed}\n`,
        );
        process.stdout.write(`kept:    ${result.kept}\n`);
        process.stdout.write(`scanned: ${result.scanned}\n`);
        process.stdout.write(`max_age_days: ${maxAgeDays}\n`);
        if (result.files.length > 0 && dryRun) {
          for (const f of result.files) {
            process.stdout.write(`  ${f}\n`);
          }
        }
        return;
      }

      const policy = await loadSessionPolicy(root);
      const actorDefaults = await loadActorDefaults(root);
      const base = await inboxBaseConfig(root);
      const buildConfig = (projectId: string): InboxWatcherConfig => ({
        inboxDir: base.inboxDir,
        processedDir: base.processedDir,
        errorDir: base.errorDir,
        debounceMs: base.debounceMs,
        projectId,
        projectRoot: base.projectRoot,
      });
      if (opts.process) {
        const result = await runInboxCommand(
          root,
          policy,
          actorDefaults,
          Effect.gen(function* () {
            const projects = yield* ProjectService;
            const row = yield* projects.ensure({ name: base.projectName });
            return yield* drainInbox(buildConfig(row.id));
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
      if (opts.reprocess) {
        const result = await runInboxCommand(
          root,
          policy,
          actorDefaults,
          Effect.gen(function* () {
            const projects = yield* ProjectService;
            const row = yield* projects.ensure({ name: base.projectName });
            return yield* reprocessErrorDir(buildConfig(row.id));
          }),
        );
        if (getOutputMode() === "json") {
          emit("json", "inbox", {
            processed: result.processed,
            errored: result.errored,
          });
          return;
        }
        process.stdout.write(`reprocessed: ${result.processed} moved to processed\n`);
        process.stdout.write(`still errored: ${result.errored}\n`);
        return;
      }
      if (opts.status) {
        const counts = await inboxFileCounts({
          inboxDir: base.inboxDir,
          errorDir: base.errorDir,
        });
        const lastDrain = await readLastDrainStamp(base.inboxDir);
        if (getOutputMode() === "json") {
          emit("json", "inbox", {
            pending: counts.pending,
            errored: counts.errored,
            last_drain: lastDrain,
          });
          return;
        }
        process.stdout.write(`pending:    ${counts.pending}\n`);
        process.stdout.write(`errored:    ${counts.errored}\n`);
        process.stdout.write(`last drain: ${lastDrain ?? "never"}\n`);
        return;
      }
      if (opts.installWatch) {
        // §4.2: print a user-mode supervisor unit that runs the watcher
        // for headless/CI. The generator never touches the filesystem;
        // we print to stdout so the user pipes it where they like.
        const platform = detectPlatform();
        if (platform === "unknown") {
          process.stderr.write(
            "cognit: --install-watch supports Linux (systemd) and macOS (launchd) only\n",
          );
          process.exitCode = 2;
          return;
        }
        const unit =
          platform === "systemd"
            ? generateSystemdUnit({ workingDir: root })
            : generateLaunchdUnit({ workingDir: root });
        process.stdout.write(unit);
        if (getOutputMode() !== "json") {
          process.stderr.write(
            platform === "systemd"
              ? `\n# Install (user mode): save as ~/.config/systemd/user/cognit-inbox.service, then:\n#   systemctl --user daemon-reload && systemctl --user enable --now cognit-inbox\n`
              : `\n# Install: save as ~/Library/LaunchAgents/com.cognit.inbox-watch.plist, then:\n#   launchctl load ~/Library/LaunchAgents/com.cognit.inbox-watch.plist\n`,
          );
        }
        return;
      }
      if (opts.watch) {
        await runInboxCommand(
          root,
          policy,
          actorDefaults,
          Effect.gen(function* () {
            const projects = yield* ProjectService;
            const row = yield* projects.ensure({ name: base.projectName });
            const watcher = yield* runInboxWatcher(buildConfig(row.id));
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
