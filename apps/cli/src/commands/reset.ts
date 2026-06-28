/**
 * apps/cli/src/commands/reset.ts
 *
 * `cognit reset [--root <path>] [--yes] [--keep-config]`
 *
 * Wipe the local Cognit project state. Intended for "I want to start
 * over" — the user has decided the existing `.cognit/` data is not
 * worth preserving. The command refuses to run unless one of:
 *
 *   - the user types `reset` at the interactive prompt, OR
 *   - `--yes` is passed (script-friendly form).
 *
 * The prompt is read from stdin so it works in non-TTY contexts (CI
 * scripts piping input); when stdin is not a TTY the prompt is
 * skipped and `--yes` is required.
 *
 * --keep-config preserves `cognit.yaml` (and the `.gitignore`
 * snippet) but removes everything else inside `.cognit/`. The
 * directory itself is preserved so subsequent writes don't have to
 * recreate it. Use case: nuke the DB / inbox / snapshots / archive
 * but keep the operator-authored config.
 *
 * Output:
 *   - text: short confirmation + path list of what was removed.
 *   - json (`--json`): the v1 envelope with `root` and `removed[]`
 *     listing the exact paths that were unlinked.
 *
 * Exit codes: 0 on success, 1 when the project root has no
 * `.cognit/cognit.yaml`, 2 when the user declines the confirmation,
 * and the global handler's 1 on any unexpected throw.
 */
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { Command } from "commander";
import { isCognitProject, projectPaths } from "../paths.js";
import { emit, getOutputMode } from "../output.js";

interface ResetOptions {
  root?: string;
  yes?: boolean;
  keepConfig?: boolean;
}

const resolveProjectRoot = (opts: ResetOptions, globals: { root?: string }): string =>
  path.resolve(opts.root ?? globals.root ?? process.env["COGNIT_ROOT"] ?? process.cwd());

/**
 * Interactive confirmation. Reads from stdin until the user types
 * `reset` (followed by Enter), or EOF. Returns `true` when the user
 * confirmed, `false` on EOF / wrong input / timeout.
 *
 * In a non-TTY environment (piped stdin from a script, no controlling
 * terminal) the prompt is skipped and confirmation is auto-denied;
 * callers must pass `--yes` for scripted use.
 */
const confirmReset = async (): Promise<boolean> => {
  if (!process.stdin.isTTY) return false;
  process.stderr.write("This will delete .cognit/. Type 'reset' to confirm: ");
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    const onLine = (line: string): void => {
      rl.close();
      resolve(line.trim() === "reset");
    };
    rl.once("line", onLine);
    rl.once("close", () => resolve(false));
  });
};

/**
 * Remove the contents of `.cognit/` while preserving the
 * `cognit.yaml` + `.gitignore` files. Returns the list of paths
 * actually unlinked. We list first, then `rm` each — `fs.rm` with
 * `recursive: true` would also nuke the files we want to keep.
 */
const wipePreservingConfig = async (cognitDir: string): Promise<string[]> => {
  const entries = await fs.readdir(cognitDir, { withFileTypes: true });
  const removed: string[] = [];
  for (const entry of entries) {
    if (entry.name === "cognit.yaml" || entry.name === ".gitignore") continue;
    const p = path.join(cognitDir, entry.name);
    await fs.rm(p, { recursive: true, force: true });
    removed.push(p);
  }
  return removed;
};

export function registerReset(program: Command): void {
  program
    .command("reset")
    .description("wipe .cognit/ in the current project (confirmation required; --yes to skip)")
    .option("--root <path>", "project root (default: $COGNIT_ROOT or current directory)")
    .option("--yes", "skip the confirmation prompt (script-friendly)")
    .option("--keep-config", "preserve cognit.yaml and .gitignore; remove the rest of .cognit/")
    .action(async (opts: ResetOptions, command) => {
      const globals = command.optsWithGlobals() as { root?: string };
      const projectRoot = resolveProjectRoot(opts, globals);

      if (!isCognitProject(projectRoot)) {
        process.stderr.write(`cognit: not a Cognit project at ${projectRoot} (no .cognit/cognit.yaml)\n`);
        process.exitCode = 1;
        return;
      }

      if (!opts.yes) {
        const ok = await confirmReset();
        if (!ok) {
          process.stderr.write("cognit: reset cancelled.\n");
          process.exitCode = 2;
          return;
        }
      }

      const cognitDirPath = projectPaths(projectRoot).dir;
      let removed: string[] = [];
      if (opts.keepConfig) {
        removed = await wipePreservingConfig(cognitDirPath);
      } else {
        // Capture for the JSON envelope BEFORE the rm so we can
        // still report what would have been removed if (somehow) the
        // directory is already gone — the `force: true` swallows
        // ENOENT in that case.
        try {
          const entries = await fs.readdir(cognitDirPath, { withFileTypes: true });
          removed = entries.map((e) => path.join(cognitDirPath, e.name));
        } catch {
          removed = [];
        }
        await fs.rm(cognitDirPath, { recursive: true, force: true });
      }

      if (getOutputMode() === "json") {
        emit("json", "reset", { root: projectRoot, removed });
      } else {
        process.stdout.write(`Reset complete. Run 'cognit init' to start fresh.\n`);
        if (removed.length > 0) {
          process.stdout.write(`Removed:\n`);
          for (const r of removed) process.stdout.write(`  - ${r}\n`);
        }
      }
    });
}