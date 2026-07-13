/**
 * D-M2-02 — shell completion generator.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/run-cli";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cognit-completion-"));
});

afterEach(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

describe("cognit completion", () => {
  for (const shell of ["fish", "bash", "zsh"] as const) {
    it(`emits a non-empty ${shell} script with public verbs and --root`, () => {
      const r = runCli(tmp, ["completion", shell]);
      expect(r.status).toBe(0);
      expect(r.stdout.length).toBeGreaterThan(50);
      expect(r.stdout).toContain("continue");
      expect(r.stdout).toContain("observation");
      expect(r.stdout).toMatch(/--root|root/);
    });
  }

  it("fails with usage exit for unknown shell", () => {
    const r = runCli(tmp, ["completion", "powershell"]);
    expect(r.status).toBe(2);
  });
});
