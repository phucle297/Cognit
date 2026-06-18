import { Command } from "commander";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findProjectRoot } from "../paths.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// apps/cli/src/commands/server.ts -> ../../../apps/server/src/index.ts
// (HERE=commands, ..=src, ..=cli, ..=apps, ..=repo root)
const SERVER_ENTRY = path.resolve(HERE, "..", "..", "..", "apps", "server", "src", "index.ts");

interface ServerOptions {
  host?: string;
  port?: string;
  root?: string;
  apiToken?: string;
}

/**
 * `cognit server [--host <ip>] [--port <n>] [--root <p>] [--api-token <t>]`
 *
 * Phase 3d: spawn the Hono server in `apps/server` as a child
 * process. The server shares the project's `.cognit/cognit.db`
 * SQLite file with the CLI; both processes read the same
 * append-only event log. The child process inherits stdio so
 * the user sees the same log output as a direct server run.
 *
 * Auth precedence in the server (highest first):
 *   1. `COGNIT_API_TOKEN` env var (escapes a leaked yaml).
 *   2. `--api-token` CLI flag passed here.
 *   3. `auth.api_token` field in `.cognit/cognit.yaml`.
 *
 * By default (loopback bind, no token) the server is fully open.
 * Use `--host 0.0.0.0` together with any of the above to require
 * bearer auth on every protected route. The dashboard (phase 6)
 * is served same-origin and uses a HttpOnly+SameSite=Strict cookie
 * set by `POST /auth/login` so EventSource clients can authenticate.
 */
export function registerServer(program: Command): void {
  program
    .command("server")
    .description("boot the Hono read API server on 127.0.0.1:6971 (phase 3d + 5.x)")
    .option("--host <ip>", "bind host (default 127.0.0.1; use 0.0.0.0 with an api token to require auth)", "127.0.0.1")
    .option("--port <n>", "bind port", (v: string) => Number(v), 6971)
    .option("--root <path>", "project root (defaults to nearest .cognit/cognit.yaml)")
    .option("--api-token <token>", "bearer token (overrides yaml; env COGNIT_API_TOKEN overrides this)")
    .action(async (opts: ServerOptions) => {
      const root = opts.root ?? findProjectRoot();
      if (!root) {
        process.stderr.write("cognit: no .cognit/cognit.yaml found. Run `cognit init` first.\n");
        process.exitCode = 2;
        return;
      }
      // Resolve tsx from the server package (devDep). Falls back to
      // the workspace root if not present.
      const tsx = path.resolve(HERE, "..", "..", "..", "..", "apps", "server", "node_modules", ".bin", "tsx");
      const args = [SERVER_ENTRY];
      if (opts.host) args.push("--host", opts.host);
      if (opts.port) args.push("--port", String(opts.port));
      if (root) args.push("--root", root);
      if (opts.apiToken) args.push("--api-token", opts.apiToken);
      const child = spawn(tsx, args, { stdio: "inherit" });
      const onSignal = (sig: NodeJS.Signals): void => {
        if (!child.killed) child.kill(sig);
      };
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
      child.on("exit", (code, sig) => {
        process.removeListener("SIGINT", onSignal);
        process.removeListener("SIGTERM", onSignal);
        if (sig) {
          process.kill(process.pid, sig);
        } else {
          process.exit(code ?? 0);
        }
      });
    });
}
