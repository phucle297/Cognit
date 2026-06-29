/**
 * apps/cli/tests/e2e/workflow-scenarios.e2e.test.ts — M2.1.
 *
 * Five realistic Claude-session scenarios driven end-to-end through
 * the CLI. Each one proves that the generated CLAUDE.md gives Claude
 * enough to use Cognit correctly AND that the captured memories are
 * rich enough for the NEXT Claude session to resume via
 * `cognit continue` without any hand-off.
 *
 * The five scenarios mirror the spec at M2.1 §Task 5:
 *   1. Feature implementation — happy path with verify pass
 *   2. Bug investigation — search + observation + verify
 *   3. Refactor — observation + decision + verify (no conclusion)
 *   4. Failed verification — the memory must NOT hide the failure
 *   5. Resume next day — fresh "session" pointer, `continue` reads
 *      the prior session's memories
 *
 * The verbs used are exactly the six in the generated CLAUDE.md:
 * observation / decision propose / verification / conclusion propose /
 * continue / search. No hidden APIs. If CLAUDE.md is wrong the tests
 * break here.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/run-cli";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cognit-m21-"));
});

afterEach(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

/** Helper: initialise a fresh project + remove the sticky current-session
 * pointer so `continue` exercises the "pick most recent open session"
 * path that the next-day resume scenario needs. */
const initFresh = (): void => {
  expect(runCli(tmp, ["init", "--project", "scenario"]).status).toBe(0);
  const pointer = path.join(tmp, ".cognit", "current-session");
  if (fs.existsSync(pointer)) fs.unlinkSync(pointer);
};

/** Run a subprocess-backed verification that always exits 0. */
const runPassingVerify = (label: string): void => {
  const r = runCli(tmp, [
    "verification",
    "--type",
    "exec",
    "--",
    "node",
    "-e",
    "process.stdout.write('ok')",
  ]);
  expect(r.status, `${label} verify should exit 0; got: ${r.stderr}`).toBe(0);
};

/** Run a subprocess-backed verification that always exits 1.
 * The CLI itself may still exit 0 because the engine has already
 * persisted the `verification_failed` event by the time we return —
 * what matters is the event in the DB. */
const runFailingVerify = (): void => {
  const r = runCli(tmp, [
    "verification",
    "--type",
    "test",
    "--",
    "node",
    "-e",
    "process.exit(1)",
  ]);
  // Either exit 0 (engine handled the failure) or non-zero is fine.
  // The assertion lives in the caller — it reads the DB.
  void r;
};

describe("M2.1 Scenario 1 — feature implementation", () => {
  it("Claude captures intent, decision, evidence, conclusion", () => {
    initFresh();

    // Claude notices the gap.
    expect(
      runCli(tmp, ["observation", "users want a /health endpoint"]).status,
    ).toBe(0);

    // Claude picks the design.
    expect(
      runCli(tmp, [
        "decision",
        "propose",
        "implement /health as a thin GET returning {status:ok}",
      ]).status,
    ).toBe(0);

    // Claude runs evidence.
    runPassingVerify("feature-impl");

    // Claude closes the decision.
    expect(
      runCli(tmp, [
        "conclusion",
        "propose",
        "/health returns 200 with {status:ok} — covered by exec verify",
      ]).status,
    ).toBe(0);

    // Next-session resume reads everything back.
    fs.unlinkSync(path.join(tmp, ".cognit", "current-session"));
    const cont = runCli(tmp, ["continue"]);
    expect(cont.status).toBe(0);
    expect(cont.stdout).toContain("/health endpoint");
    expect(cont.stdout).toContain("GET returning {status:ok}");
    expect(cont.stdout).toContain("Verified:");
    expect(cont.stdout).toContain("/health returns 200");
  });
});

describe("M2.1 Scenario 2 — bug investigation", () => {
  it("Claude searches history, then records the repro and fix", () => {
    initFresh();

    // Pre-seed history so search returns a hit — proves the recall
    // path before the new observations land.
    expect(
      runCli(tmp, [
        "observation",
        "auth uses refresh tokens with 1h TTL and rotate on use",
      ]).status,
    ).toBe(0);

    // Search history first — Claude should reach for this BEFORE
    // re-investigating.
    const search = runCli(tmp, ["search", "auth refresh token"]);
    expect(search.status).toBe(0);
    expect(search.stdout).toContain("Matches for");
    expect(search.stdout).toContain("refresh tokens");

    // Claude captures the repro.
    expect(
      runCli(tmp, [
        "observation",
        "repro: refresh fails on rotated signing key, returns 401",
      ]).status,
    ).toBe(0);

    // Claude proposes the fix.
    expect(
      runCli(tmp, [
        "decision",
        "propose",
        "fall back to previous valid key for 60s grace window",
      ]).status,
    ).toBe(0);

    runPassingVerify("bug-investigation");

    // The continuation must surface both the repro and the chosen fix
    // so the next session knows what was decided.
    fs.unlinkSync(path.join(tmp, ".cognit", "current-session"));
    const cont = runCli(tmp, ["continue"]);
    expect(cont.stdout).toContain("401");
    expect(cont.stdout).toContain("60s grace window");
  });
});

describe("M2.1 Scenario 3 — refactor without closing", () => {
  it("Claude leaves an open hypothesis so the next session can finish", () => {
    initFresh();

    expect(
      runCli(tmp, [
        "observation",
        "three near-identical ad-hoc parsers in commands/{x,y,z}.ts",
      ]).status,
    ).toBe(0);

    expect(
      runCli(tmp, [
        "decision",
        "propose",
        "extract shared parser to packages/core/parser.ts",
      ]).status,
    ).toBe(0);

    // Verify the refactor still typechecks before pausing.
    const tc = runCli(tmp, [
      "verification",
      "--type",
      "typecheck",
      "--",
      "node",
      "-e",
      "process.stdout.write('ts ok')",
    ]);
    expect(tc.status).toBe(0);

    // No conclusion proposed — the refactor is open. The continuation
    // must still surface what was decided so the next session can pick
    // it up.
    fs.unlinkSync(path.join(tmp, ".cognit", "current-session"));
    const cont = runCli(tmp, ["continue"]);
    expect(cont.stdout).toContain("parser.ts");
    expect(cont.stdout).toContain("Next:");
  });
});

describe("M2.1 Scenario 4 — failed verification", () => {
  it("Claude's failed verification is visible in continue", () => {
    initFresh();

    expect(
      runCli(tmp, ["observation", "patch ready for the bug above"]).status,
    ).toBe(0);

    expect(
      runCli(tmp, [
        "decision",
        "propose",
        "apply patch — drop the optimistic cache check",
      ]).status,
    ).toBe(0);

    runFailingVerify();

    // The failing verification MUST surface — otherwise the next
    // session would think the patch was good.
    fs.unlinkSync(path.join(tmp, ".cognit", "current-session"));
    const cont = runCli(tmp, ["continue"]);
    expect(cont.status).toBe(0);
    expect(cont.stdout).toContain("optimistic cache");
    // The trust footer counts rejected verifications — proves the
    // failure landed in memory and is queryable on resume.
    expect(cont.stdout).toMatch(/rejected/);
  });
});

describe("M2.1 Scenario 5 — resume next day using continue", () => {
  it("a fresh Claude session picks up the prior session via continue", () => {
    initFresh();

    // Day 1 — Claude does work, leaves an open hypothesis.
    expect(
      runCli(tmp, ["observation", "switching auth library from passport to lucia"]).status,
    ).toBe(0);
    expect(
      runCli(tmp, [
        "decision",
        "propose",
        "use lucia for session management, drop passport middleware",
      ]).status,
    ).toBe(0);
    runPassingVerify("day-1");

    // Day 2 — fresh load: the sticky current-session pointer must NOT
    // exist. `continue` should still find the prior session because it
    // falls back to "most recent open session" in this project.
    fs.unlinkSync(path.join(tmp, ".cognit", "current-session"));

    const cont = runCli(tmp, ["continue"]);
    expect(cont.status).toBe(0);

    // Another Claude must be able to read intent, decision, and
    // outcome from this single command.
    expect(cont.stdout).toContain("lucia");
    expect(cont.stdout).toContain("drop passport");
    expect(cont.stdout).toMatch(/Verified|Decided/);

    // Search across the prior session must work too.
    const search = runCli(tmp, ["search", "passport"]);
    expect(search.status).toBe(0);
    expect(search.stdout).toContain("lucia");
  });
});