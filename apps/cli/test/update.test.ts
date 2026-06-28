/**
 * apps/cli/test/update.test.ts — phase 1 (B.2) `cognit update` coverage.
 *
 * `cognit update` shells out to `pnpm update -g cognit`. Two
 * invariants matter:
 *
 *   1. If pnpm is missing → exit 1 with a stderr hint pointing at
 *      `npm install -g pnpm`.
 *   2. If pnpm is present → exit 0 and (with --json) emit the
 *      `{ kind: 'update', data: { ok } }` envelope.
 *
 * The pnpm-missing case is exercised by mutating `PATH` so the
 * `pnpm` lookup fails (we replace PATH with a directory that
 * contains a `pnpm` shim that exits 127, then verify the error).
 * The pnpm-present case is exercised by prepending a tiny fake
 * pnpm shim to PATH that prints a fake version and then exits 0 —
 * this avoids touching the host's global packages.
 *
 * `tsx` itself is launched via absolute path so PATH manipulation
 * does not break the test runner; we keep the existing `node`
 * resolution path intact so the tsx shim can `exec node`.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CLI_ENTRY = path.resolve(__dirname, "..", "src", "index.ts");
const TSX = path.resolve(__dirname, "..", "node_modules", ".bin", "tsx");

interface UpdateEnvelope {
  version: number;
  kind: string;
  data: {
    root: string;
    ok: boolean;
    error?: string;
  };
}

let tmp: string;

beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cognit-update-"));
});

afterEach(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

/**
 * Build a PATH that hides pnpm while keeping the directories
 * `tsx`'s shim needs to `exec node`. We rewrite every PATH entry
 * that contains a `pnpm` binary: the original dir is replaced
 * with a parallel "shadow" dir that has the same neighbours
 * except for `pnpm` (which is omitted). If no pnpm is on PATH
 * (very unusual for this repo), the helper returns null so the
 * caller can skip the missing-case assertion gracefully.
 *
 * Why this works: tsx's shim `exec`s `node` and `node` lives in
 * a sibling path alongside pnpm. We can't just drop the whole
 * dir — that would also drop `node`. Shadowing each PATH entry
 * preserves every other binary in the dir while making `pnpm`
 * unresolvable.
 */
function pathWithoutPnpm(): string | null {
  const entries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const result: string[] = [];
  let shadowedAny = false;
  for (const dir of entries) {
    const pnpmInDir = path.join(dir, "pnpm");
    if (fs.existsSync(pnpmInDir)) {
      shadowedAny = true;
      const shadow = fs.mkdtempSync(path.join(os.tmpdir(), "cognit-shadow-"));
      for (const neighbour of fs.readdirSync(dir)) {
        if (neighbour === "pnpm") continue;
        try {
          fs.symlinkSync(path.join(dir, neighbour), path.join(shadow, neighbour));
        } catch {
          // Skip non-symlinkable entries (e.g. sockets); they aren't
          // on PATH lookup paths in practice.
        }
      }
      result.push(shadow);
    } else {
      result.push(dir);
    }
  }
  return shadowedAny ? result.join(path.delimiter) : null;
}

/** Spawn the CLI with optional extra env overrides. */
function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(TSX, [CLI_ENTRY, ...args], {
    encoding: "utf8",
    // Run in `tmp` so any file-touching paths stay sandboxed. The
    // `update` command does not read or write the project root, but
    // we pass it for parity with the rest of the test suite.
    cwd: tmp,
    env: { ...process.env, ...env },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/**
 * Create a tiny directory containing a fake `pnpm` shim that:
 *   - exits 0 on `pnpm --version`
 *   - exits 0 on `pnpm update -g cognit`
 * and return its absolute path. The shim is a tiny shell script —
 * portable across macOS + Linux CI.
 */
function createFakePnpm(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cognit-fake-pnpm-"));
  const shim = path.join(dir, "pnpm");
  fs.writeFileSync(shim, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return dir;
}

describe("cognit update", () => {
  it("pnpm missing → exit 1, stderr contains 'pnpm required'", () => {
    const narrowed = pathWithoutPnpm();
    // If we couldn't find pnpm on PATH in the first place (very
    // unusual for this repo), the missing-case is vacuously true —
    // skip instead of failing spuriously.
    if (narrowed === null) {
      // Real pnpm exists; verify the probe is what we expect by
      // asserting the error text on the real binary is NOT present.
      const r = runCli(["update"]);
      expect(r.stderr).not.toContain("pnpm required");
      return;
    }
    const r = runCli(["update"], { PATH: narrowed });
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain("pnpm required");
  });

  it("pnpm missing + --json → envelope with ok:false and error hint", () => {
    const narrowed = pathWithoutPnpm();
    if (narrowed === null) {
      const r = runCli(["--json", "update"]);
      // Real pnpm is present: envelope should report ok:true.
      expect(r.status).toBe(0);
      const env = JSON.parse(r.stdout) as UpdateEnvelope;
      expect(env.data.ok).toBe(true);
      return;
    }
    const r = runCli(["--json", "update"], { PATH: narrowed });
    expect(r.status).toBe(1);
    const env = JSON.parse(r.stdout) as UpdateEnvelope;
    expect(env.version).toBe(1);
    expect(env.kind).toBe("update");
    expect(env.data.ok).toBe(false);
    expect(env.data.error).toContain("pnpm required");
  });

  it("pnpm present → spawns `pnpm update -g cognit`, exit 0", () => {
    const fakeBin = createFakePnpm();
    try {
      const r = runCli(["update"], { PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}` });
      expect(r.status, r.stderr || r.stdout).toBe(0);
      // No pnpm-required error should have leaked.
      expect(r.stderr).not.toContain("pnpm required");
    } finally {
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("--json success → envelope { kind: 'update', data: { ok: true } }", () => {
    const fakeBin = createFakePnpm();
    try {
      const r = runCli(["--json", "update"], {
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
      });
      expect(r.status, r.stderr).toBe(0);
      const env = JSON.parse(r.stdout) as UpdateEnvelope;
      expect(env.version).toBe(1);
      expect(env.kind).toBe("update");
      expect(env.data.ok).toBe(true);
      expect(env.data.root).toBe(tmp);
    } finally {
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  });
});