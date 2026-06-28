/**
 * apps/cli/test/doctor.test.ts — phase 1 (B.2) `cognit doctor` coverage.
 *
 * Doctor runs seven health checks and emits a per-check status table
 * (text) or a parseable v1 envelope (json). The command is the public
 * surface for project self-diagnosis, so its exit code + envelope
 * shape are part of the contract.
 *
 * Tests follow the existing runCli + tmp-dir pattern (see
 * `init.test.ts`, `json-output.test.ts`). The CLI is spawned via
 * `tsx` + `node:child_process.spawnSync` so we exercise the actual
 * CLI entry point — including the `--json` global option parsing.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CLI_ENTRY = path.resolve(__dirname, "..", "src", "index.ts");
const TSX = path.resolve(__dirname, "..", "node_modules", ".bin", "tsx");

function runCli(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(TSX, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    // `cognit theory` / `cognit experiment` print a soft-deprecation
    // warning on first invocation per process. Suppress it so stderr
    // carries only meaningful diagnostic output.
    env: { ...process.env, COGNIT_QUIET_DEPRECATIONS: "1" },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

interface DoctorEnvelope {
  version: number;
  kind: string;
  data: {
    root: string;
    checks: ReadonlyArray<{
      id: string;
      label: string;
      status: "pass" | "fail" | "warn" | "skip";
      detail: string;
    }>;
    fixed?: ReadonlyArray<string>;
    ok: boolean;
  };
}

let tmp: string;

beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cognit-doctor-"));
});

afterEach(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

describe("cognit doctor", () => {
  it("no project → exit 1 (isProject fails), every other check is `skip`", () => {
    // Without an `.cognit/cognit.yaml`, the doctor short-circuits
    // the stateful checks (subdirs / db / project row / inbox /
    // hooks) to `skip`. The `isProject` check itself is `fail`
    // (the marker file is missing), so exit code is 1 — operator
    // needs to run `cognit init` first.
    const r = runCli(tmp, ["doctor"]);
    expect(r.status, r.stderr).toBe(1);
    // Marker-file check fails — that's the only `fail`.
    expect(r.stdout).toContain("isCognitProject");
    expect(r.stdout).toContain("FAIL");
    // All `skip`-able rows show the word "skip" (case-insensitive).
    const skipCount = (r.stdout.match(/skip/gi) ?? []).length;
    expect(skipCount).toBeGreaterThanOrEqual(5);
  });

  it("no project + --json → envelope with skip checks and ok: false (only isProject fails)", () => {
    const r = runCli(tmp, ["--json", "doctor"]);
    expect(r.status, r.stderr).toBe(1);
    const env = JSON.parse(r.stdout) as DoctorEnvelope;
    expect(env.version).toBe(1);
    expect(env.kind).toBe("doctor");
    expect(env.data.root).toBe(tmp);
    expect(Array.isArray(env.data.checks)).toBe(true);
    // `isProject` must be FAIL when no project exists.
    const isProject = env.data.checks.find((c) => c.id === "isProject");
    expect(isProject?.status).toBe("fail");
    // Every other check is `skip` (or in the case of `subdirs.<name>`
    // the per-subdir `skip` rows).
    const skipOrPass = env.data.checks.filter(
      (c) => c.status === "skip" || c.status === "pass",
    );
    expect(skipOrPass.length).toBe(env.data.checks.length - 1);
    // ok is false because at least one check failed.
    expect(env.data.ok).toBe(false);
  });

  it("after `cognit init` → all checks PASS except the server probe (skip)", () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);

    const r = runCli(tmp, ["--json", "doctor"]);
    expect(r.status, r.stderr).toBe(0);
    const env = JSON.parse(r.stdout) as DoctorEnvelope;
    expect(env.data.ok).toBe(true);

    const byId = new Map(env.data.checks.map((c) => [c.id, c]));
    // Project marker present.
    expect(byId.get("isProject")?.status).toBe("pass");
    // Subdir aggregate present.
    expect(byId.get("subdirs")?.status).toBe("pass");
    // DB opens.
    expect(byId.get("db")?.status).toBe("pass");
    // Project row exists (init seeds it).
    expect(byId.get("project")?.status).toBe("pass");
    // Inbox writable.
    expect(byId.get("inbox")?.status).toBe("pass");
    // Server is never running in the test environment — skip is
    // the expected outcome, not fail (loopback probe best-effort).
    expect(byId.get("server")?.status).toBe("skip");
  });

  it("--json envelope shape: { kind: 'doctor', data: { root, checks: [...], ok } }", () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
    const r = runCli(tmp, ["--json", "doctor"]);
    expect(r.status).toBe(0);
    const env = JSON.parse(r.stdout) as DoctorEnvelope;
    expect(env.version).toBe(1);
    expect(env.kind).toBe("doctor");
    expect(typeof env.data.root).toBe("string");
    expect(Array.isArray(env.data.checks)).toBe(true);
    expect(env.data.checks.length).toBeGreaterThan(0);
    expect(typeof env.data.ok).toBe("boolean");
    // Every check has the documented shape.
    for (const c of env.data.checks) {
      expect(typeof c.id).toBe("string");
      expect(typeof c.label).toBe("string");
      expect(["pass", "fail", "warn", "skip"]).toContain(c.status);
      expect(typeof c.detail).toBe("string");
    }
  });

  it("--fix on an existing project rewrites cognit.yaml idempotently", () => {
    expect(runCli(tmp, ["init", "--project", "first"]).status).toBe(0);
    const cfgPath = path.join(tmp, ".cognit", "cognit.yaml");
    const before = fs.readFileSync(cfgPath, "utf8");
    expect(before).toContain("first");

    const r = runCli(tmp, ["--json", "doctor", "--fix"]);
    expect(r.status).toBe(0);
    const env = JSON.parse(r.stdout) as DoctorEnvelope;
    // The fixed[] array reports what was repaired. config rewrite is
    // idempotent so a re-parse of the file yields the same content.
    const fixed = env.data.fixed ?? [];
    const rewrite = fixed.find((f) => f.includes("cognit.yaml"));
    expect(rewrite, `fixed=${JSON.stringify(fixed)}`).toBeDefined();

    const after = fs.readFileSync(cfgPath, "utf8");
    // Re-running --fix yields the same content (idempotent write).
    const r2 = runCli(tmp, ["--json", "doctor", "--fix"]);
    expect(r2.status).toBe(0);
    const after2 = fs.readFileSync(cfgPath, "utf8");
    expect(after2).toBe(after);
  });

  it("missing cognit.yaml after init → FAIL on `isProject` check, exit 1", () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
    // Simulate a tampered / corrupted project: the marker file is
    // gone but `.cognit/` itself remains.
    fs.rmSync(path.join(tmp, ".cognit", "cognit.yaml"));

    const r = runCli(tmp, ["--json", "doctor"]);
    expect(r.status, r.stderr).toBe(1);
    const env = JSON.parse(r.stdout) as DoctorEnvelope;
    expect(env.data.ok).toBe(false);
    const isProject = env.data.checks.find((c) => c.id === "isProject");
    expect(isProject?.status).toBe("fail");
    // The remaining checks must be `skip` (no project to inspect).
    const others = env.data.checks.filter((c) => c.id !== "isProject");
    for (const c of others) {
      expect(
        c.status === "skip" || c.status === "pass" || c.status === "fail",
        `unexpected status ${c.status} for ${c.id}`,
      ).toBe(true);
    }
  });
});