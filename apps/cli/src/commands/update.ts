/**
 * apps/cli/src/commands/update.ts
 *
 * `cognit update [--root <path>]`
 *
 * Self-update wrapper around `pnpm update -g cognit`. Cognit is
 * distributed as a globally installed pnpm package; this command is
 * the documented "get the latest version" entry point so users don't
 * have to remember the package manager incantation.
 *
 * The child inherits stdio so the user sees pnpm's progress bars and
 * prompts in their terminal. We translate the exit code into our
 * own: pnpm exit 0 → process exit 0; anything else → exit 1 with
 * a stderr hint.
 *
 * `pnpm` is mandatory: the bootstrap path documented in the README
 * is `npm install -g pnpm && pnpm install -g cognit`, so a user
 * without pnpm should get a clear error pointing at the install
 * command rather than a confusing ENOENT.
 *
 * Output:
 *   - text: nothing on success (pnpm prints its own summary), an
 *     error line on failure.
 *   - json (`--json`): the v1 envelope `{ root, ok }` regardless of
 *     pnpm's exit code (the envelope is emitted before we propagate
 *     the failure via `process.exitCode`).
 *
 * `--root` is accepted for parity with the rest of the CLI but is
 * unused — `cognit update` is a global-package operation, not a
 * project-scoped one.
 */
import { spawn } from "node:child_process";
import { Command } from "commander";
import { emit, getOutputMode } from "../output.js";

interface UpdateOptions {
  root?: string;
}

const resolveProjectRoot = (opts: UpdateOptions, globals: { root?: string }): string =>
  opts.root ?? globals.root ?? process.env["COGNIT_ROOT"] ?? process.cwd();

/**
 * Probe for pnpm on PATH. We spawn `pnpm --version` with a short
 * timeout — if it doesn't print within 5s we treat pnpm as
 * unavailable. ENOENT (the typical "command not found" case) is
 * caught here too.
 */
const pnpmAvailable = async (): Promise<boolean> =>
  new Promise((resolve) => {
    let resolved = false;
    const done = (v: boolean): void => {
      if (resolved) return;
      resolved = true;
      resolve(v);
    };
    try {
      const child = spawn("pnpm", ["--version"], { stdio: "ignore" });
      const timer = setTimeout(() => {
        child.kill();
        done(false);
      }, 5000);
      child.on("error", () => {
        clearTimeout(timer);
        done(false);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        done(code === 0);
      });
    } catch {
      done(false);
    }
  });

/**
 * Spawn `pnpm update -g cognit` and wait for it. Inherits stdio so
 * the user sees pnpm's own progress output verbatim. Returns the
 * child's exit code, or `null` when it was killed by a signal.
 */
const runPnpmUpdate = (): Promise<number | null> =>
  new Promise((resolve) => {
    let resolved = false;
    const done = (v: number | null): void => {
      if (resolved) return;
      resolved = true;
      resolve(v);
    };
    const child = spawn("pnpm", ["update", "-g", "cognit"], { stdio: "inherit" });
    child.on("error", (e) => {
      process.stderr.write(`cognit: failed to spawn pnpm: ${e.message}\n`);
      done(1);
    });
    child.on("exit", (code, sig) => done(sig !== null ? null : code));
    // Forward signals so Ctrl-C tears down the pnpm child too.
    const onSig = (s: NodeJS.Signals): void => {
      if (!child.killed) child.kill(s);
    };
    process.on("SIGINT", onSig);
    process.on("SIGTERM", onSig);
    child.on("exit", () => {
      process.removeListener("SIGINT", onSig);
      process.removeListener("SIGTERM", onSig);
    });
  });

export function registerUpdate(program: Command): void {
  program
    .command("update")
    .description("update the global cognit CLI via pnpm")
    .option("--root <path>", "unused (accepted for CLI parity with other commands)")
    .action(async (opts: UpdateOptions, command) => {
      const globals = command.optsWithGlobals() as { root?: string };
      const projectRoot = resolveProjectRoot(opts, globals);

      const havePnpm = await pnpmAvailable();
      if (!havePnpm) {
        const msg = "pnpm required: npm install -g pnpm";
        if (getOutputMode() === "json") {
          emit("json", "update", { root: projectRoot, ok: false, error: msg });
        } else {
          process.stderr.write(`cognit: ${msg}\n`);
        }
        process.exitCode = 1;
        return;
      }

      const code = await runPnpmUpdate();
      const ok = code === 0;

      if (getOutputMode() === "json") {
        emit("json", "update", { root: projectRoot, ok });
      } else if (!ok) {
        process.stderr.write(`cognit: pnpm update failed (exit ${code ?? "signal"})\n`);
      }

      if (!ok) process.exitCode = 1;
    });
}