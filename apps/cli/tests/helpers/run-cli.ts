/**
 * apps/cli/tests/helpers/run-cli.ts
 *
 * Spawn the CLI for integration / e2e tests.
 *
 * Design:
 *   - Run `node dist/index.js`, NOT `tsx src/index.ts`. tsup bundles once
 *     per `pnpm build` (~90ms). tsx re-transpiles on every spawn and pays
 *     commander / drizzle / better-sqlite3 cold-start per spawn — that
 *     cold-start was the dominant cost in the old suite (~660ms vs ~250ms
 *     per spawn after the switch).
 *   - The dist is invalidated by the package scripts (`test:integration`
 *     and `test:e2e` both run `pnpm build` first). Local `test` reuses
 *     whatever dist exists; CI rebuilds.
 *   - Tests pass `cwd` (typically a `mkdtemp` project root) and `args`.
 *     `opts.env` is merged on top of `process.env` so tests can stub
 *     `llm.api_key_env` etc. without mutating the parent process.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Absolute path to the bundled CLI entry.
 *
 * Resolves to `<repo>/apps/cli/dist/index.js` regardless of where the
 * test process is launched from.
 */
export const CLI_BIN = path.resolve(
  __dirname,
  "..",
  "..",
  "dist",
  "index.js",
);

export interface RunCliOpts {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
}

export interface RunCliResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Synchronously spawn the CLI with the given args in `cwd`.
 *
 * Returns `{ status, stdout, stderr }` — same shape as `spawnSync`'s
 * trimmed output. `status` is `-1` when the process was killed by signal.
 */
export function runCli(
  cwd: string,
  args: string[],
  opts: RunCliOpts = {},
): RunCliResult {
  const result = spawnSync(process.execPath, [CLI_BIN, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...(opts.env ?? {}) },
    timeout: opts.timeoutMs ?? 30_000,
    input: opts.input,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}