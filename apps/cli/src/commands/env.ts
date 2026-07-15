import path from "node:path";
import process from "node:process";
import fs from "node:fs";
import YAML from "yaml";
import { Command } from "commander";
import { projectPaths } from "../paths.js";

/**
 * Read the current-session pointer (`.cognit/current-session`).
 * Returns `null` when the file is missing or unreadable. The hook
 * shell bootstrap relies on this so `$COGNIT_SESSION_ID` resolves
 * to the session most recently created/resumed by the user.
 */
const readCurrentSession = (projectRoot: string): string | null => {
  const p = projectPaths(projectRoot).currentSession;
  try {
    const raw = fs.readFileSync(p, "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
};

/**
 * D-M4-00 §4.1: export `COGNIT_REALTIME=1` only when
 * `inbox.realtime: true` in cognit.yaml. Sync + lightweight (no full
 * Schema validation) so `cognit env` stays safe before `init` and
 * stays fast for shell bootstrap. Omitted when false/missing so
 * hooks default to lazy drain only.
 *
 * Hooks gate fire-and-forget `cognit inbox --process` on this var —
 * never parse yaml themselves (latency + host constraints).
 */
const readRealtime = (projectRoot: string): string | null => {
  const configPath = projectPaths(projectRoot).config;
  try {
    const text = fs.readFileSync(configPath, "utf8");
    const parsed = YAML.parse(text) as { inbox?: { realtime?: unknown } } | null;
    return parsed?.inbox?.realtime === true ? "1" : null;
  } catch {
    return null;
  }
};

/**
 * Registry of env vars exposed by `cognit env`. Static entries are
 * derived from the resolved project root only — no DB read, no
 * `.cognit/` walk-up, so this command is safe to run before
 * `cognit init` (and that's the whole point: hook setup needs
 * `$COGNIT_INBOX` to point at the inbox that `init` will create).
 *
 * `COGNIT_SESSION_ID` is dynamic: it reads `.cognit/current-session`
 * and is omitted when no session has been created yet (so `eval
 * "$(cognit env --shell)"` never exports an empty value).
 *
 * `COGNIT_REALTIME` is dynamic: exported as `"1"` only when
 * `inbox.realtime: true` in cognit.yaml (D-M4-00 §4.1). Omitted
 * otherwise so hooks stay on the lazy-drain path by default.
 *
 * Add new vars by appending a `KEY -> (root) => value` entry. The
 * `env --shell`, `env` table, and `env KEY` forms all read this
 * single source.
 */
const ENV_VARS: Readonly<Record<string, (projectRoot: string) => string | null>> = {
  COGNIT_INBOX: (projectRoot) => projectPaths(projectRoot).inbox,
  COGNIT_SESSION_ID: (projectRoot) => readCurrentSession(projectRoot),
  COGNIT_REALTIME: (projectRoot) => readRealtime(projectRoot),
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
      // Drop keys whose resolver returned null (e.g. COGNIT_SESSION_ID
      // before the first `cognit session create`). Excluded from both
      // `--shell` and the table form so the bootstrap is never noisy.
      const entries = KNOWN_KEYS.flatMap((k) => {
        const v = ENV_VARS[k]!(projectRoot);
        return v === null ? [] : ([[k, v]] as const);
      });

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
        const value = ENV_VARS[key]!(projectRoot);
        if (value === null) {
          // Empty string preserves the script-composable contract
          // (`cognit env COGNIT_SESSION_ID` never fails) while letting
          // callers distinguish "unset" from "missing key".
          process.stdout.write("\n");
          return;
        }
        process.stdout.write(`${value}\n`);
        return;
      }

      // Readable table form.
      const keyWidth = Math.max(3, ...KNOWN_KEYS.map((k) => k.length));
      process.stdout.write(`${"KEY".padEnd(keyWidth)}  VALUE\n`);
      process.stdout.write(`${"-".repeat(keyWidth)}  ${"-".repeat(5)}\n`);
      for (const [k, v] of entries) {
        process.stdout.write(`${k.padEnd(keyWidth)}  ${v}\n`);
      }
    });
}