/**
 * apps/cli/src/commands/dashboard.ts
 *
 * `cognit dashboard [--root <path>] [--port <n>] [--api-port <n>] [--no-open]`
 *
 * Host-only local-first:
 *   1. Resolve Cognit root (cwd / --root / $COGNIT_ROOT)
 *   2. Spawn API for THAT root on 127.0.0.1:<api-port> (default 6971;
 *      auto-bump if busy)
 *   3. Spawn Vite UI on 127.0.0.1:<ui-port> (default 6970), proxy /api → API
 *
 * No Docker. Run `pnpm run setup` once to link the CLI, then from any
 * project: `cognit init` + `cognit dashboard`.
 */
import { Command } from "commander";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findProjectRoot } from "../paths.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

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
  port?: string;
  apiPort?: string;
  open?: boolean;
  root?: string;
}

const isPortFree = (port: number, host = "127.0.0.1"): Promise<boolean> =>
  new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => {
      srv.close(() => resolve(true));
    });
    srv.listen(port, host);
  });

const pickFreePort = async (
  start: number,
  exclude: ReadonlySet<number> = new Set(),
): Promise<number> => {
  for (let p = start; p < start + 30; p++) {
    if (exclude.has(p)) continue;
    if (await isPortFree(p)) return p;
  }
  throw new Error(`no free port in range ${start}–${start + 29}`);
};

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
  for (const c of children) {
    if (c === primary) continue;
    c.on("exit", (code, sig) => {
      if (code && code !== 0) {
        process.stderr.write(
          `cognit: API process exited (code=${code}${sig ? ` signal=${sig}` : ""}). Stopping UI.\n`,
        );
        killAll("SIGTERM");
        process.exit(code);
      }
    });
  }
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
      "start the dashboard for this Cognit root (cwd / --root); API + UI",
    )
    .option("--root <path>", "Cognit root (default: $COGNIT_ROOT or nearest .cognit/)")
    .option("--port <n>", "dashboard UI port (default: 6970)")
    .option("--api-port <n>", "preferred API port (default: 6971; auto-bumps if busy)")
    .option("--no-open", "do not open the browser automatically")
    .action(async (opts: DashboardOptions) => {
      const preferredUi = Number(opts.port ?? "6970");
      const preferredApi = Number(opts.apiPort ?? "6971");

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
          `cognit: cannot find server entry/tsx under ${REPO_ROOT}. Run \`pnpm run setup\` from the Cognit monorepo.\n`,
        );
        process.exitCode = 1;
        return;
      }

      let apiPort: number;
      let uiPort: number;
      try {
        apiPort = await pickFreePort(preferredApi);
        uiPort = await pickFreePort(preferredUi, new Set([apiPort]));
      } catch (e) {
        process.stderr.write(`cognit: ${(e as Error).message}\n`);
        process.exitCode = 1;
        return;
      }

      if (apiPort !== preferredApi) {
        process.stderr.write(
          `cognit: port ${preferredApi} is busy; using API port ${apiPort} for this project's .cognit.\n`,
        );
      }
      if (uiPort !== preferredUi) {
        process.stderr.write(`cognit: UI port ${preferredUi} busy; using ${uiPort}.\n`);
      }

      const url = `http://127.0.0.1:${uiPort}/`;
      const apiUrl = `http://127.0.0.1:${apiPort}`;

      process.stderr.write(
        `cognit: root=${root}\n` +
          `cognit: starting API on ${apiUrl} (this root's .cognit)\n` +
          `cognit: starting UI  on ${url}\n`,
      );

      const server = spawn(
        tsx,
        [SERVER_ENTRY, "--host", "127.0.0.1", "--port", String(apiPort), "--root", root],
        {
          stdio: "inherit",
          cwd: REPO_ROOT,
          env: { ...process.env, COGNIT_REPO_ROOT: REPO_ROOT },
        },
      );

      const viteBin =
        [
          path.join(REPO_ROOT, "apps", "dashboard", "node_modules", ".bin", "vite"),
          path.join(REPO_ROOT, "node_modules", ".bin", "vite"),
        ].find((p) => existsSync(p)) ?? "vite";
      const ui = spawn(
        viteBin,
        ["--host", "127.0.0.1", "--port", String(uiPort), "--strictPort"],
        {
          stdio: "inherit",
          cwd: path.join(REPO_ROOT, "apps", "dashboard"),
          env: { ...process.env, COGNIT_API_PROXY: apiUrl },
        },
      );

      wireProcessGroup([server, ui], ui);

      if (opts.open !== false) {
        setTimeout(() => openBrowser(url), 2000);
      }
    });
}
