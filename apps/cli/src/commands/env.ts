import path from "node:path";
import process from "node:process";
import { Command } from "commander";
import { projectPaths } from "../paths.js";

/**
 * Registry of env vars exposed by `cognit env`. Each value is
 * derived from the resolved project root only — no DB read, no
 * `.cognit/` walk-up, so this command is safe to run before
 * `cognit init` (and that's the whole point: hook setup needs
 * `$COGNIT_INBOX` to point at the inbox that `init` will create).
 *
 * Add new vars by appending a `KEY -> (root) => value` entry. The
 * `env --shell`, `env` table, and `env KEY` forms all read this
 * single source.
 */
const ENV_VARS: Readonly<Record<string, (projectRoot: string) => string>> = {
  COGNIT_INBOX: (projectRoot) => projectPaths(projectRoot).inbox,
};

const KNOWN_KEYS = Object.keys(ENV_VARS);

interface EnvOptions {
  shell?: boolean;
  root?: string;
}

/**
 * Escape a value for safe inclusion in a `double-quoted` shell
 * string consumed by `eval`. Escapes backslashes, double quotes,
 * dollar signs, and backticks (the four characters that would
 * otherwise let a value escape its quotes). Newlines become a
 * literal `\n`. Paths won't normally contain these, but a future
 * env var (e.g. a JSON blob) might.
 */
const shellQuote = (value: string): string =>
  value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`")
    .replace(/\n/g, "\\n");

/**
 * Resolve the project root for `cognit env` using the same precedence
 * as `cognit init` (`init.ts:42-47`):
 *   1. subcommand `--root` flag
 *   2. global `--root` flag (so `cognit --root /data env` works)
 *   3. `$COGNIT_ROOT` env var
 *   4. `process.cwd()`
 *
 * Deliberately does NOT call `findProjectRoot` (which walks up
 * looking for `.cognit/cognit.yaml`). `env` is meant to work before
 * `init` has run; requiring the marker file would defeat the
 * bootstrap use case the phase is fixing.
 */
const resolveProjectRoot = (opts: EnvOptions, globals: { root?: string }): string =>
  opts.root ?? globals.root ?? process.env["COGNIT_ROOT"] ?? process.cwd();

/**
 * `cognit env [--shell] [--root <path>] [KEY]`
 *
 * - `cognit env --shell`              → `export KEY="value"` lines,
 *                                        one per registered var. Safe
 *                                        to `eval` in any POSIX shell.
 * - `cognit env` (no flag)            → human-readable table.
 * - `cognit env COGNIT_INBOX`         → just that value, one line, no
 *                                        shell prefix. Composable in
 *                                        scripts.
 *
 * No side effects. No DB. No `.cognit/` writes. The resolved root
 * is purely a path base for the values (e.g. `<root>/.cognit/inbox`);
 * the directory does not need to exist for `env` to succeed.
 */
export function registerEnv(program: Command): void {
  program
    .command("env [key]")
    .description("print hook-relevant env vars (e.g. $COGNIT_INBOX) for the current project; honours --root")
    .option("--shell", "emit `export KEY=\"value\"` lines suitable for `eval`")
    .option("--root <path>", "project root (default: $COGNIT_ROOT or current directory)")
    .action((key: string | undefined, opts: EnvOptions, command) => {
      const globals = command.optsWithGlobals() as { root?: string };
      const projectRoot = path.resolve(resolveProjectRoot(opts, globals));
      const entries = KNOWN_KEYS.map((k) => [k, ENV_VARS[k]!(projectRoot)] as const);

      if (opts.shell) {
        for (const [k, v] of entries) {
          process.stdout.write(`export ${k}="${shellQuote(v)}"\n`);
        }
        return;
      }

      if (key !== undefined) {
        if (!(key in ENV_VARS)) {
          process.stderr.write(
            `cognit: unknown env key "${key}". Known keys: ${KNOWN_KEYS.join(", ")}\n`,
          );
          process.exitCode = 1;
          return;
        }
        process.stdout.write(`${ENV_VARS[key]!(projectRoot)}\n`);
        return;
      }

      // Readable table form.
      const keyWidth = Math.max(3, ...entries.map(([k]) => k.length));
      process.stdout.write(`${"KEY".padEnd(keyWidth)}  VALUE\n`);
      process.stdout.write(`${"-".repeat(keyWidth)}  ${"-".repeat(5)}\n`);
      for (const [k, v] of entries) {
        process.stdout.write(`${k.padEnd(keyWidth)}  ${v}\n`);
      }
    });
}