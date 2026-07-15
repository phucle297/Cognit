/**
 * apps/cli/src/commands/dashboard.ts
 *
 * `cognit dashboard [--root <path>] [--port <n>] [--api-port <n>] [--no-open] [--docker]`
 *
 * Local-only tool — no auth. Data model for the UI:
 *   One Cognit root (the directory with `.cognit/`) per process.
 *   There is no multi-project picker. Run from (or `--root`) the
 *   directory you care about after `cognit init`.
 *
 * Default (host) flow:
 *   1. Resolve root: --root → $COGNIT_ROOT → nearest .cognit/cognit.yaml
 *   2. Spawn API server for that root on 127.0.0.1:6971
 *   3. Spawn Vite dashboard on 127.0.0.1:6970 (proxies /api → :6971)
 *
 * `--docker` is optional legacy path (compose volume, not cwd DB).
 */
import { Command } from "commander";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findProjectRoot } from "../paths.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/**
 * Resolve monorepo root whether this file is:
 *   - source: apps/cli/src/commands/dashboard.ts  (4× ..)
 *   - bundle: apps/cli/dist/index.js               (3× ..)
 */
const resolveRepoRoot = (): string => {
  const candidates = [
    path.resolve(HERE, "..", "..", ".."), // dist/
    path.resolve(HERE, "..", "..", "..", ".."), // src/commands/
  ];
  for (const c of candidates) {
    if (
      existsSync(path.join(c, "pnpm-workspace.yaml")) ||
      existsSync(path.join(c, "apps", "server", "src", "index.ts"))
    ) {
      return c;
    }
  }
  return candidates[0]!;
};
const REPO_ROOT = resolveRepoRoot();
const SERVER_ENTRY = path.resolve(REPO_ROOT, "apps", "server", "src", "index.ts");

interface DashboardOptions {
  docker?: boolean;
  port?: string;
  apiPort?: string;
  build?: boolean;
  open?: boolean;
  root?: string;
}

const findComposeRoot = (start: string): string | undefined => {
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, "docker-compose.yml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
};

const runningInsideDocker = (): boolean =>
  existsSync("/.dockerenv") || Boolean(process.env["DOCKER_CONTAINER_ID"]);

const openBrowser = (url: string): void => {
  const cmd =
    process.platform === "darwin"
      ? { bin: "open", args: [url] }
      : process.platform === "win32"
        ? { bin: "cmd", args: ["/c", "start", "", url] }
        : { bin: "xdg-open", args: [url] };
  try {
    const child = spawn(cmd.bin, cmd.args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      process.stderr.write(
        `cognit: could not open browser (no \`${cmd.bin}\` on PATH). Open ${url} manually.\n`,
      );
    });
    child.unref();
  } catch {
    process.stderr.write(`cognit: could not open browser. Open ${url} manually.\n`);
  }
};

/** Kill all children on SIGINT/SIGTERM; exit when the primary (UI) exits. */
const wireProcessGroup = (children: ChildProcess[], primary: ChildProcess): void => {
  const killAll = (sig: NodeJS.Signals): void => {
    for (const c of children) {
      if (!c.killed) c.kill(sig);
    }
  };
  const onSignal = (sig: NodeJS.Signals): void => {
    killAll(sig);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  primary.on("exit", (code, sig) => {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    for (const c of children) {
      if (c !== primary && !c.killed) c.kill("SIGTERM");
    }
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
    .description(
      "start the dashboard for this Cognit root (cwd / --root); API + UI, no project picker",
    )
    .option("--docker", "legacy: docker compose dashboard (volume DB, not cwd)")
    .option("--root <path>", "Cognit root (default: $COGNIT_ROOT or nearest .cognit/)")
    .option("--port <n>", "dashboard UI port (default: 6970)")
    .option("--api-port <n>", "API port (default: 6971)")
    .option("--build", "with --docker: force-rebuild dashboard image")
    .option("--no-open", "do not open the browser automatically")
    .action(async (opts: DashboardOptions) => {
      const useDocker =
        opts.docker === true ||
        process.env["COGNIT_DOCKER"] === "1" ||
        runningInsideDocker();
      const uiPort = opts.port ?? "6970";
      const apiPort = opts.apiPort ?? "6971";
      const url = `http://127.0.0.1:${uiPort}/`;

      if (useDocker) {
        const repoRoot = findComposeRoot(process.cwd()) ?? REPO_ROOT;
        const composeFile = path.join(repoRoot, "docker-compose.yml");
        if (!existsSync(composeFile)) {
          process.stderr.write(
            `cognit: docker-compose.yml not found. Prefer host mode: run \`cognit dashboard\` from a project after \`cognit init\`.\n`,
          );
          process.exitCode = 2;
          return;
        }
        const args = [
          "compose",
          "-f",
          composeFile,
          "--profile",
          "dashboard",
          "run",
          "--rm",
          "-p",
          `127.0.0.1:${uiPort}:${uiPort}`,
          "--service-ports",
          "dashboard",
        ];
        if (opts.build) args.push("--build");
        process.stderr.write(
          `cognit: starting dashboard via docker compose on ${url} (API is compose volume, not cwd)\n`,
        );
        const child = spawn("docker", args, { cwd: repoRoot, stdio: "inherit" });
        wireProcessGroup([child], child);
        if (opts.open !== false) setTimeout(() => openBrowser(url), 1500);
        return;
      }

      // --- Host mode: one root = this directory's .cognit ---
      const root =
        opts.root ??
        process.env["COGNIT_ROOT"] ??
        findProjectRoot(process.cwd()) ??
        null;
      if (!root) {
        process.stderr.write(
          "cognit: no Cognit root found. cd into a project and run `cognit init`, then `cognit dashboard`.\n",
        );
        process.exitCode = 2;
        return;
      }

      const tsxCandidates = [
        path.join(REPO_ROOT, "apps", "server", "node_modules", ".bin", "tsx"),
        path.join(REPO_ROOT, "node_modules", ".bin", "tsx"),
      ];
      const tsx = tsxCandidates.find((p) => existsSync(p));
      if (!tsx || !existsSync(SERVER_ENTRY)) {
        process.stderr.write(
          `cognit: cannot find server entry/tsx under ${REPO_ROOT}. Rebuild the monorepo (pnpm install).\n`,
        );
        process.exitCode = 1;
        return;
      }

      process.stderr.write(
        `cognit: root=${root}\n` +
          `cognit: starting API on http://127.0.0.1:${apiPort} (this root's .cognit)\n` +
          `cognit: starting UI  on ${url}\n`,
      );

      const server = spawn(
        tsx,
        [SERVER_ENTRY, "--host", "127.0.0.1", "--port", String(apiPort), "--root", root],
        { stdio: "inherit", cwd: REPO_ROOT },
      );

      const pnpmLocal = path.join(REPO_ROOT, "node_modules", ".bin", "pnpm");
      const pnpm = existsSync(pnpmLocal) ? pnpmLocal : "pnpm";
      const ui = spawn(
        pnpm,
        ["--filter", "@cognit/dashboard", "dev", "--", "--port", uiPort, "--strictPort"],
        { stdio: "inherit", cwd: REPO_ROOT },
      );

      wireProcessGroup([server, ui], ui);

      if (opts.open !== false) {
        setTimeout(() => openBrowser(url), 2000);
      }
    });
}
