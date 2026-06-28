/**
 * apps/cli/test/aliases.test.ts — phase 1 (B.3) CLI alias coverage.
 *
 * Three lifecycle verbs are aliased to the canonical event-named
 * commands so new users discover them through the public surface:
 *
 *   - `cognit check`     →  `cognit verify`
 *   - `cognit decide`    →  `cognit decision`
 *   - `cognit conclude`  →  `cognit conclusion`
 *
 * The aliases are thin wrappers (`apps/cli/src/commands/check.ts`
 * etc.) that re-invoke the canonical registration against an
 * isolated `Command` instance. This test file proves three things:
 *
 *   1. `--help` on each alias forwards to the canonical help output.
 *   2. `cognit --help` lists every alias under the public Commands
 *      section.
 *   3. The canonical names (`verify`, `decision`, `conclusion`) do
 *      NOT appear as command entries under the public surface —
 *      they are hidden behind `--internal`.
 *
 * The aliases' own descriptions reference the canonical names in
 * backticks; the public-surface test only matches the start of an
 * indented command entry (Commander renders those with two leading
 * spaces), so the backtick references inside descriptions don't
 * trigger a false positive.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

const CLI_ENTRY = path.resolve(__dirname, "..", "src", "index.ts");
const TSX = path.resolve(__dirname, "..", "node_modules", ".bin", "tsx");

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(TSX, [CLI_ENTRY, ...args], {
    encoding: "utf8",
    // `cognit theory` / `cognit experiment` print a soft-deprecation
    // warning on first invocation per process. Suppress it so the
    // help-output assertions aren't polluted by side-channel stderr.
    env: { ...process.env, COGNIT_QUIET_DEPRECATIONS: "1" },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** Extract the indented command lines under `Commands:`. */
function publicCommandsBlock(helpText: string): string {
  return helpText.split(/^Commands:/m)[1] ?? "";
}

describe("cognit aliases (phase 1 B.3)", () => {
  describe("alias --help forwards to canonical help", () => {
    it("`cognit check --help` shows verify subcommands (cancel/pass/fail/error/rerun)", () => {
      const r = runCli(["check", "--help"]);
      expect(r.status, r.stderr).toBe(0);
      // The forwarded help is the verify help — its description and
      // subcommand list are identical to `cognit verify --help`.
      expect(r.stdout).toContain("verification lifecycle");
      expect(r.stdout).toContain("Usage: cognit verify");
      expect(r.stdout).toContain("cancel");
      expect(r.stdout).toContain("pass");
      expect(r.stdout).toContain("fail");
      expect(r.stdout).toContain("error");
      expect(r.stdout).toContain("rerun");
    });

    it("`cognit decide --help` shows decision subcommands (propose/accept/reject/supersede)", () => {
      const r = runCli(["decide", "--help"]);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("4-state lifecycle");
      expect(r.stdout).toContain("Usage: cognit decision");
      expect(r.stdout).toContain("propose");
      expect(r.stdout).toContain("accept");
      expect(r.stdout).toContain("reject");
      expect(r.stdout).toContain("supersede");
    });

    it("`cognit conclude --help` shows conclusion subcommands (propose/verify/reject)", () => {
      const r = runCli(["conclude", "--help"]);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("conclusion lifecycle");
      expect(r.stdout).toContain("Usage: cognit conclusion");
      expect(r.stdout).toContain("propose");
      expect(r.stdout).toContain("verify");
      expect(r.stdout).toContain("reject");
    });
  });

  describe("public surface — cognit --help", () => {
    it("aliases appear in `cognit --help` (public) under Commands", () => {
      const r = runCli(["--help"]);
      expect(r.status, r.stderr).toBe(0);
      const cmds = publicCommandsBlock(r.stdout);
      // Each alias renders with two leading spaces + the verb +
      // ` [args...]` (Commander variadic marker).
      expect(cmds).toMatch(/^  check\b/m);
      expect(cmds).toMatch(/^  decide\b/m);
      expect(cmds).toMatch(/^  conclude\b/m);
    });

    it("canonical names do NOT appear as public command entries", () => {
      const r = runCli(["--help"]);
      expect(r.status, r.stderr).toBe(0);
      const cmds = publicCommandsBlock(r.stdout);
      // Each canonical command would render with two leading spaces
      // + its name if visible. Alias descriptions mention these
      // names in backticks (e.g. "alias for `cognit verify`") but
      // those live further right on the description line, not at
      // column 3. The line-start regex anchors on `  word\b` so
      // backtick references don't match.
      expect(cmds, "`verify` should not be a public command").not.toMatch(/^  verify\b/m);
      expect(cmds, "`decision` should not be a public command").not.toMatch(/^  decision\b/m);
      expect(cmds, "`conclusion` should not be a public command").not.toMatch(/^  conclusion\b/m);
    });

    it("canonical names DO appear with --internal --help", () => {
      const r = runCli(["--internal", "--help"]);
      expect(r.status, r.stderr).toBe(0);
      const cmds = publicCommandsBlock(r.stdout);
      expect(cmds).toMatch(/^  verify\b/m);
      expect(cmds).toMatch(/^  decision\b/m);
      expect(cmds).toMatch(/^  conclusion\b/m);
    });
  });

  describe("alias forwarding behaviour", () => {
    it("check --help and verify --help render the same canonical help", () => {
      const a = runCli(["check", "--help"]);
      const b = runCli(["--internal", "verify", "--help"]);
      // Both should succeed.
      expect(a.status, a.stderr).toBe(0);
      expect(b.status, b.stderr).toBe(0);
      // The forwarded help renders identical "Usage:" lines.
      const usageA = a.stdout.match(/^Usage: [^\n]+/m)?.[0] ?? "";
      const usageB = b.stdout.match(/^Usage: [^\n]+/m)?.[0] ?? "";
      expect(usageA).toBe(usageB);
      expect(usageA).toContain("cognit verify");
    });
  });
});