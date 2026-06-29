/**
 * apps/cli/test/reset.test.ts — phase 1 (B.2) `cognit reset` coverage.
 *
 * Reset wipes `.cognit/`. It refuses to run on a non-project dir,
 * prompts the user to type `reset` at the TTY, and supports
 * `--yes` (script-friendly) and `--keep-config` (preserve
 * `cognit.yaml` + `.gitignore`). The JSON envelope reports every
 * removed path so operators can audit what was unlinked.
 *
 * `spawnSync` provides a non-TTY stdin to the child — the same shape
 * CI scripts see. The non-TTY branch auto-denies confirmation, which
 * is exactly what `--yes` exists to override.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/run-cli";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

interface ResetEnvelope {
  version: number;
  kind: string;
  data: {
    root: string;
    removed: ReadonlyArray<string>;
  };
}

let tmp: string;

beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cognit-reset-"));
});

afterEach(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

/** Init + create a session so `.cognit/` has rows in the db. */
function bootstrapProject(goal: string): string {
  expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
  const create = runCli(tmp, ["session", "create", goal]);
  expect(create.status).toBe(0);
  const sessionId = create.stdout.match(/session:\s+(01[A-Z0-9]+)/i)![1]!;
  // Ensure `.cognit/` is non-trivial: add a snapshot so the db is on disk.
  expect(runCli(tmp, ["snapshot", "--session", sessionId]).status).toBe(0);
  return sessionId;
}

describe("cognit reset", () => {
  it("no project → exit 1 with a helpful stderr message", () => {
    // No `init` ran — there's nothing to wipe.
    const r = runCli(tmp, ["reset", "--yes"]);
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain("not a Cognit project");
    expect(r.stderr).toContain(tmp);
  });

  it("--yes removes .cognit/ entirely, exit 0", () => {
    bootstrapProject("reset wipes all");

    const r = runCli(tmp, ["--json", "reset", "--yes"]);
    expect(r.status, r.stderr).toBe(0);

    // `.cognit/` itself is gone (recursive rm).
    expect(fs.existsSync(path.join(tmp, ".cognit"))).toBe(false);

    const env = JSON.parse(r.stdout) as ResetEnvelope;
    expect(env.version).toBe(1);
    expect(env.kind).toBe("reset");
    expect(env.data.root).toBe(tmp);
    expect(env.data.removed.length).toBeGreaterThan(0);
    // The reported paths all live under `.cognit/`.
    for (const p of env.data.removed) {
      expect(p.startsWith(path.join(tmp, ".cognit"))).toBe(true);
    }
  });

  it("--keep-config preserves cognit.yaml + .gitignore, removes the rest", () => {
    bootstrapProject("reset keep config");

    const cfgPath = path.join(tmp, ".cognit", "cognit.yaml");
    const giPath = path.join(tmp, ".cognit", ".gitignore");
    const dbPath = path.join(tmp, ".cognit", "cognit.db");
    const beforeCfg = fs.readFileSync(cfgPath, "utf8");

    const r = runCli(tmp, ["--json", "reset", "--yes", "--keep-config"]);
    expect(r.status, r.stderr).toBe(0);

    // Config + .gitignore survive, unchanged.
    expect(fs.existsSync(cfgPath)).toBe(true);
    expect(fs.existsSync(giPath)).toBe(true);
    expect(fs.readFileSync(cfgPath, "utf8")).toBe(beforeCfg);

    // The db is gone.
    expect(fs.existsSync(dbPath)).toBe(false);

    const env = JSON.parse(r.stdout) as ResetEnvelope;
    expect(env.data.removed.length).toBeGreaterThan(0);
    // The removed list MUST NOT include cognit.yaml or .gitignore.
    for (const p of env.data.removed) {
      const base = path.basename(p);
      expect(base).not.toBe("cognit.yaml");
      expect(base).not.toBe(".gitignore");
    }
  });

  it("--json envelope shape: { kind: 'reset', data: { root, removed: [paths] } }", () => {
    bootstrapProject("reset json envelope");

    const r = runCli(tmp, ["--json", "reset", "--yes"]);
    expect(r.status).toBe(0);
    const env = JSON.parse(r.stdout) as ResetEnvelope;
    expect(env.version).toBe(1);
    expect(env.kind).toBe("reset");
    expect(env.data.root).toBe(tmp);
    expect(Array.isArray(env.data.removed)).toBe(true);
    expect(env.data.removed.every((p) => typeof p === "string")).toBe(true);
  });

  it("non-TTY without --yes → exit 2 (refuses without confirmation)", () => {
    bootstrapProject("reset refuses without yes");

    // spawnSync with no piped stdin = EOF on the child's stdin.
    // The command interprets that as "non-TTY" and denies
    // confirmation even if the user typed nothing.
    const r = runCli(tmp, ["reset"]);
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toContain("cancelled");
    // The project survives — no destructive side effects on refusal.
    expect(fs.existsSync(path.join(tmp, ".cognit", "cognit.yaml"))).toBe(true);
  });
});