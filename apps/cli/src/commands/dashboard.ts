/**
 * apps/cli/src/commands/dashboard.ts
 *
 * `cognit dashboard [--docker] [--port <n>] [--build] [--no-open]`
 *
 * Local-only tool — no auth. The dashboard is a Vite SPA that talks
 * to the local Hono server over loopback. It runs on demand:
 *
 *   - default (host):  spawn `pnpm --filter @cognit/dashboard dev`
 *                      (vite dev server on http://127.0.0.1:5173)
 *   - --docker:        `docker compose --profile dashboard run --rm`
 *                      (nginx + Vite dist on http://127.0.0.1:6970)
 *
 * The `--docker` path expects to be invoked from a directory inside
 * the Cognit checkout (it walks up looking for docker-compose.yml).
 * Inside a running container it is auto-detected via `/.dockerenv`.
 *
 * Use `cognit server` in another terminal (or `--docker` together
 * with `docker compose up -d server`) so the API has something to
 * proxy to.
 */
import { Command } from "commander";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { spawn as spawnAsync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// apps/cli/src/commands/dashboard.ts -> ../../../../  (repo root)
const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..");

interface DashboardOptions {
  docker?: boolean;
  port?: string;
  build?: boolean;
  open?: boolean;
}

/** Walk up from `start` looking for a file that marks the repo root. */
const findRepoRoot = (start: string): string | undefined => {
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, "docker-compose.yml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
};

/** Heuristic: are we already running inside a container? */
const runningInsideDocker = (): boolean =>
  existsSync("/.dockerenv") ||
  // Docker sets DOCKER_CONTAINER_ID in some setups. The /.dockerenv
  // file is the canonical signal — keep this as a cheap fallback.
  Boolean(process.env["DOCKER_CONTAINER_ID"]);

/**
 * Open a URL in the user's default browser. Best-effort: if no
 * platform opener is on PATH we just print the URL.
 */
const openBrowser = (url: string): void => {
  const cmd = process.platform === "darwin"
    ? { bin: "open", args: [url] }
    : process.platform === "win32"
      ? { bin: "cmd", args: ["/c", "start", "", url] }
      : { bin: "xdg-open", args: [url] };
  try {
    const child = spawnAsync(cmd.bin, cmd.args, { stdio: "ignore", detached: true });
    child.unref();
  } catch {
    /* swallow — non-fatal */
  }
};

/**
 * Forward signals from the parent CLI to the spawned child so Ctrl-C
 * tears down the dashboard (and, for `docker compose run --rm`, the
 * container) cleanly.
 */
const forwardSignals = (child: ReturnType<typeof spawn>): void => {
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
};

export function registerDashboard(program: Command): void {
  program
    .command("dashboard")
    .description("start the dashboard on demand (vite dev locally, docker compose with --docker)")
    .option("--docker", "run via docker compose --profile dashboard (nginx + Vite dist on :6970)")
    .option("--port <n>", "override dashboard port (default: 5173 local, 6970 docker)")
    .option("--build", "with --docker: force-rebuild the dashboard image before starting")
    .option("--no-open", "do not open the browser automatically")
    .action(async (opts: DashboardOptions) => {
      const useDocker = opts.docker === true
        || process.env["COGNIT_DOCKER"] === "1"
        || runningInsideDocker();

      if (useDocker) {
        const repoRoot = findRepoRoot(process.cwd()) ?? REPO_ROOT;
        const composeFile = path.join(repoRoot, "docker-compose.yml");
        if (!existsSync(composeFile)) {
          process.stderr.write(
            `cognit: docker-compose.yml not found (looked up from ${process.cwd()} to ${repoRoot}). ` +
            `Run \`cognit dashboard --docker\` from inside the Cognit checkout, or set --port / --no-open.\n`,
          );
          process.exitCode = 2;
          return;
        }
        const port = opts.port ?? "6970";
        const args = ["compose", "-f", composeFile, "--profile", "dashboard", "run", "--rm", "-p", `127.0.0.1:${port}:${port}`, "--service-ports", "dashboard"];
        if (opts.build) args.push("--build");
        process.stderr.write(`cognit: starting dashboard via docker compose (port ${port})\n`);
        const child = spawn("docker", args, { cwd: repoRoot, stdio: "inherit" });
        forwardSignals(child);
      } else {
        // Local vite dev server. Resolve pnpm + workspace via REPO_ROOT so
        // the command works no matter where `cognit` was linked from.
        const pnpm = path.join(REPO_ROOT, "node_modules", ".bin", "pnpm");
        const fallback = "pnpm"; // PATH fallback if the local .bin is missing
        const bin = existsSync(pnpm) ? pnpm : fallback;
        const port = opts.port ?? "5173";
        const args = ["--filter", "@cognit/dashboard", "dev", "--", "--port", port];
        process.stderr.write(`cognit: starting dashboard (vite dev) on http://127.0.0.1:${port}\n`);
        const child = spawn(bin, args, { cwd: REPO_ROOT, stdio: "inherit" });
        forwardSignals(child);
      }

      if (opts.open !== false) {
        const url = `http://127.0.0.1:${opts.port ?? (useDocker ? "6970" : "5173")}/`;
        // Tiny delay so the server has time to bind before the browser
        // races to connect. 1500ms is enough for vite dev; the user
        // will see the URL in stderr regardless.
        setTimeout(() => openBrowser(url), 1500);
      }
    });
}
