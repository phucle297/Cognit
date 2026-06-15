import { Command } from "commander";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findProjectRoot } from "../paths.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// packages/cli/src/commands/server.ts -> ../../../../apps/server/src/index.ts
// (HERE=commands, ..=src, ..=cli, ..=packages, ..=repo root)
const SERVER_ENTRY = path.resolve(HERE, "..", "..", "..", "..", "apps", "server", "src", "index.ts");

interface ServerOptions {
  host?: string;
  port?: string;
  root?: string;
}

/**
 * `cognit server [--host <ip>] [--port <n>] [--root <p>]`
 *
 * Phase 3d: spawn the Hono server in `apps/server` as a child
 * process. The server shares the project's `.cognit/cognit.db`
 * SQLite file with the CLI; both processes read the same
 * append-only event log. The child process inherits stdio so
 * the user sees the same log output as a direct server run.
 *
 * Auth: opt-in bearer. By default (loopback bind, no token) the
 * server is fully open. Use `--host 0.0.0.0` together with
 * `server.api_token` in `cognit.yaml` to require `Authorization:
 * Bearer <token>` on every `/sessions/*` and `/events/*` route.
 */
export function registerServer(program: Command): void {
  program
    .command("server")
    .description("boot the Hono read API server on 127.0.0.1:6971 (phase 3d)")
    .option("--host <ip>", "bind host (default 127.0.0.1; use 0.0.0.0 with server.api_token to require bearer auth)", "127.0.0.1")
    .option("--port <n>", "bind port", (v: string) => Number(v), 6971)
    .option("--root <path>", "project root (defaults to nearest .cognit/cognit.yaml)")
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
