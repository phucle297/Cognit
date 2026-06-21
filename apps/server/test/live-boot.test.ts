import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

const waitFor = async (pred: () => boolean, ms = 10000) => {
  const start = Date.now();
  while (!pred() && Date.now()-start < ms) await new Promise(r=>setTimeout(r,50));
};

describe("production index.ts live boot", () => {
  let child: ReturnType<typeof spawn> | null = null;
  let port = 0;
  let tmpDir = "";
  let stderrBuf = "";

  afterAll(async () => {
    if (child) child.kill("SIGTERM");
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("serves verify, actors, edges routes against a real production boot", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cognit-live-"));
    const dbPath = path.join(tmpDir, "cognit.db");
    await fs.mkdir(path.join(tmpDir, ".cognit"), { recursive: true });

    // Seed a project row via the CLI so the server can boot.
    await new Promise<void>((resolve, reject) => {
      const init = spawn(
        "npx",
        ["tsx", "/home/permees/Projects/github-personal/phucle297/Cognit/apps/cli/src/index.ts", "init", "--root", tmpDir, "--project", "live-verify"],
        { cwd: "/home/permees/Projects/github-personal/phucle297/Cognit", env: process.env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let initErr = "";
      init.stderr?.on("data", (d) => { initErr += d.toString(); });
      init.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("init failed: " + code + " err=" + initErr.slice(0,500)))));
    });

    child = spawn("npx", ["tsx", "/home/permees/Projects/github-personal/phucle297/Cognit/apps/server/src/index.ts", "--root", tmpDir, "--port", "0", "--host", "127.0.0.1"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        COGNIT_DB_PATH: dbPath,
        COGNIT_PROJECT_ID: "live-verify",
        COGNIT_BIND: "127.0.0.1",
        COGNIT_PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => {
      stderrBuf += d.toString();
    });
    await waitFor(() => /listening on http:\/\/127\.0\.0\.1:\d+/.test(stdout));
    const m = stdout.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
    if (!m) throw new Error("never bound. stdout=" + stdout + " stderr=" + stderrBuf.slice(0, 800));
    port = parseInt(m[1] ?? "0", 10);

    // Proof of route registration: response body must be ApiError envelope,
// NOT Hono's default 404 (empty body, no JSON envelope).
    const checks: Array<[string, string, boolean]> = [
      ["POST", "/api/verify", false],
      ["POST", "/api/verify/x/cancel", false],
      ["GET", "/api/actors", true],
      ["POST", "/api/actors", false],
      ["GET", "/api/sessions/missing/edges", false],
      ["POST", "/api/sessions/missing/edges", false],
    ];
    for (const [method, p, expectOk] of checks) {
      const isPost = method === "POST";
      const init: RequestInit = {
        method,
        headers: { "content-type": "application/json" },
        ...(isPost ? { body: "{}" } : {}),
      };
      const res = await fetch(`http://127.0.0.1:${port}${p}`, init);
      const body = (await res.text()).slice(0, 400);
      if (expectOk) {
        expect(res.status, `${method} ${p} should be 2xx, got ${res.status} body=${body}`).toBeLessThan(300);
      } else {
        const isHonoDefault404 = res.status === 404 && !body.includes('"kind":"api_error"');
        expect(
          isHonoDefault404,
          `${method} ${p} returned Hono default 404 (route NOT registered). status=${res.status} body=${body}`,
        ).toBe(false);
      }
    }
  }, 30000);
});
