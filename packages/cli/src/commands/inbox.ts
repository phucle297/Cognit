import { Command } from "commander";
import { Effect } from "effect";
import { drainInbox, runInboxWatcher } from "@cognit/db";
import { findProjectRoot, projectPaths } from "../paths.js";
import { withAppLayer } from "../layer-build.js";

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

const buildInboxConfig = (root: string) => {
  const paths = projectPaths(root);
  return {
    inboxDir: paths.inbox,
    processedDir: `${paths.dir}/processed`,
    errorDir: paths.inboxError,
    debounceMs: 200,
  };
};

const runInboxCommand = <A, E, R>(
  root: string,
  eff: Effect.Effect<A, E, R>,
): Promise<A> => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const provided = withAppLayer(root, eff) as any as Effect.Effect<A, E, never>;
  return Effect.runPromise(provided).catch((e: unknown) => {
    if (process.exitCode === undefined) process.exitCode = 1;
    process.stderr.write(`cognit: ${(e as Error).message ?? String(e)}\n`);
    throw e;
  });
};

/**
 * `cognit inbox --watch` — start a chokidar watcher (long-running).
 * `cognit inbox --process` — drain the current inbox once.
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
        process.stderr.write(
          "cognit: inbox requires --watch or --process\n",
        );
        process.exitCode = 2;
        return;
      }
      const config = buildInboxConfig(root);
      if (opts.process) {
        const result = await runInboxCommand(
          root,
          Effect.gen(function* () {
            return yield* drainInbox(config);
          }),
        );
        process.stdout.write(`processed: ${result.processed}\n`);
        process.stdout.write(`errored:   ${result.errored}\n`);
        return;
      }
      if (opts.watch) {
        await runInboxCommand(
          root,
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
