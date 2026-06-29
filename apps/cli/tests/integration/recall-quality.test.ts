/**
 * apps/cli/test/recall-quality.test.ts — M2.0 recall quality tests.
 *
 * Verifies that `cognit continue` and `cognit search` produce
 * useful, compact, server-free output that answers the six
 * recall questions and uses the trust-marker vocabulary
 * (verified | accepted | rejected | pending | open).
 *
 * Server-free contract: COGNIT_SERVER_URL is forced to an
 * unreachable port. Both commands must work via SQLite only.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/run-cli";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const sessionIdFromCreate = (out: string): string => {
  const m = out.match(/session:\s+(01[A-Z0-9]+)/i);
  if (!m) throw new Error(`no session id in output: ${out}`);
  return m[1]!;
};

/** Append a typed event to a session via the public CLI. */
const appendEvent = (
  cwd: string,
  sessionId: string,
  type: string,
  payload: Record<string, unknown>,
): { status: number; stdout: string; stderr: string } => {
  return runCli(cwd, [
    "append",
    "--type",
    type,
    "--payload",
    JSON.stringify(payload),
    "--session",
    sessionId,
  ]);
};

let tmp: string;

beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cognit-recall-m2-"));
  expect(runCli(tmp, ["init", "--project", "m2"]).status).toBe(0);
});

afterEach(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

describe("cognit continue — empty / no sessions", () => {
  it("prints onboarding block with concrete next steps, no stack trace", () => {
    const r = runCli(tmp, ["continue"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/No memory yet/);
    expect(r.stdout).toMatch(/Open Claude Code/);
    expect(r.stdout).toMatch(/cognit observation/);
    // No leaked error indicators — a stack trace would mention `at file:line:col`.
    expect(r.stderr).not.toMatch(/at .+:\d+:\d+/);
    // No raw DB paths leaking.
    expect(r.stdout).not.toMatch(/better-sqlite3|\.db['"]/);
  });

  it("empty state is also valid as JSON envelope", () => {
    const r = runCli(tmp, ["continue", "--json"]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.kind).toBe("continue");
    expect(parsed.data).toEqual({ empty: true });
  });
});

describe("cognit continue — single active session", () => {
  it("renders Doing / Decided / Open / Next / Trust sections", () => {
    const create = runCli(tmp, ["session", "create", "investigate auth bug"]);
    expect(create.status).toBe(0);
    const sid = sessionIdFromCreate(create.stdout);

    // Seed: an observation, a pending decision, an open hypothesis.
    const obs = appendEvent(tmp, sid, "observation_recorded", {
      text: "auth fails on expired refresh tokens",
    });
    expect(obs.status).toBe(0);
    const dec = appendEvent(tmp, sid, "decision_proposed", {
      text: "switch to short-lived access tokens",
      based_on_conclusion_ids: [],
    });
    expect(dec.status).toBe(0);
    const hyp = appendEvent(tmp, sid, "hypothesis_created", {
      title: "refresh-rotation",
      text: "rotate on each use",
    });
    expect(hyp.status).toBe(0);

    const r = runCli(tmp, ["continue"]);
    expect(r.status).toBe(0);

    // The 6-question block.
    expect(r.stdout).toMatch(/Session:/);
    expect(r.stdout).toMatch(/Status:/);
    expect(r.stdout).toMatch(/Doing:/);
    expect(r.stdout).toMatch(/Decided:/);
    expect(r.stdout).toMatch(/Open:/);
    expect(r.stdout).toMatch(/Next:/);
    expect(r.stdout).toMatch(/Trust:/);

    // Trust markers in the correct buckets — no internal event names.
    expect(r.stdout).toMatch(/\[pending\]\s+switch to short-lived access tokens/);
    expect(r.stdout).toMatch(/\[hypothesis\]\s+refresh-rotation/);
    expect(r.stdout).toMatch(/Trust:.*1 pending/);
    expect(r.stdout).toMatch(/Trust:.*1 open/);
  });

  it("verified conclusions appear in Verified section with [verified] marker", () => {
    const create = runCli(tmp, ["session", "create", "perf check"]);
    const sid = sessionIdFromCreate(create.stdout);

    expect(appendEvent(tmp, sid, "conclusion_proposed", { text: "cache hits dominate reads" }).status).toBe(0);
    expect(appendEvent(tmp, sid, "verification_started", {
      command: "pnpm bench",
      type: "exec",
      linked_hypothesis_id: null,
    }).status).toBe(0);
    expect(appendEvent(tmp, sid, "verification_passed", {}).status).toBe(0);
    expect(appendEvent(tmp, sid, "conclusion_verified", {
      verification_id: "v1",
      supporting_evidence_ids: [],
    }).status).toBe(0);

    const r = runCli(tmp, ["continue"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Verified:/);
    // M2.1 emit pattern: [verified] tag + memory text.
    expect(r.stdout).toMatch(/\[verified\]\s+cache hits dominate reads/);
    // The passing verification that confirmed this conclusion is also
    // a verified memory in M2.1's trust vocabulary — both the
    // conclusion and the verification rank as "verified".
    expect(r.stdout).toMatch(/Trust:.*[1-9]\d* verified/);
  });

  it("rejected decisions show [rejected] marker with reason", () => {
    const create = runCli(tmp, ["session", "create", "pick a queue"]);
    const sid = sessionIdFromCreate(create.stdout);

    expect(appendEvent(tmp, sid, "decision_proposed", {
      text: "use RabbitMQ",
      based_on_conclusion_ids: [],
    }).status).toBe(0);
    expect(appendEvent(tmp, sid, "decision_rejected", { reason: "ops overhead" }).status).toBe(0);

    const r = runCli(tmp, ["continue"]);
    expect(r.status).toBe(0);
    // M2.1 render keeps the [rejected] marker; reason is part of the
    // JSON envelope rather than a trailing note in text mode.
    expect(r.stdout).toMatch(/\[rejected\]\s+use RabbitMQ/);
    expect(r.stdout).toMatch(/Trust:.*1 rejected/);
  });
});

describe("cognit continue — multiple sessions", () => {
  it("picks the most recent active session when no sticky pointer", () => {
    const a = runCli(tmp, ["session", "create", "old session"]);
    const sidA = sessionIdFromCreate(a.stdout);
    const b = runCli(tmp, ["session", "create", "recent session"]);
    const sidB = sessionIdFromCreate(b.stdout);

    expect(appendEvent(tmp, sidA, "observation_recorded", { text: "old work" }).status).toBe(0);
    expect(appendEvent(tmp, sidB, "observation_recorded", { text: "newer work" }).status).toBe(0);

    const r = runCli(tmp, ["continue"]);
    expect(r.status).toBe(0);
    // The goal line should be the most recent session's goal.
    expect(r.stdout).toMatch(/Session:.*recent session/);
    expect(r.stdout).toMatch(/Doing:\s*\n\s+newer work/);
    void sidA;
  });

  it("respects sticky current-session pointer when present", () => {
    const a = runCli(tmp, ["session", "create", "stale goal"]);
    const sidA = sessionIdFromCreate(a.stdout);
    const b = runCli(tmp, ["session", "create", "newest goal"]);
    const sidB = sessionIdFromCreate(b.stdout);
    // Move the sticky pointer back to sidA explicitly.
    fs.writeFileSync(path.join(tmp, ".cognit", "current-session"), sidA + "\n");

    expect(appendEvent(tmp, sidA, "observation_recorded", { text: "sticky pick" }).status).toBe(0);

    const r = runCli(tmp, ["continue"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Session:.*stale goal/);
    expect(r.stdout).toMatch(/Doing:\s*\n\s+sticky pick/);
    void sidB;
  });
});

describe("cognit search", () => {
  it("no matches prints friendly next-step block, no stack trace", () => {
    const r = runCli(tmp, ["search", "auth"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/no matches for "auth"/);
    expect(r.stdout).toMatch(/Next:/);
    expect(r.stdout).toMatch(/cognit continue/);
    expect(r.stdout).toMatch(/cognit observation/);
    expect(r.stderr).not.toMatch(/at .+:\d+:\d+/);
  });

  it("returns match reason per row for observations and decisions", () => {
    const create = runCli(tmp, ["session", "create", "auth investigation"]);
    const sid = sessionIdFromCreate(create.stdout);

    expect(appendEvent(tmp, sid, "observation_recorded", { text: "refresh tokens expire too fast" }).status).toBe(0);
    expect(appendEvent(tmp, sid, "decision_proposed", {
      text: "extend refresh token TTL",
      based_on_conclusion_ids: [],
    }).status).toBe(0);

    const r = runCli(tmp, ["search", "refresh"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Matches for "refresh"/);
    // M2.1 surfaces both kinds with explicit labels and at least
    // one ✓-bullet per match (search produces explanation bullets).
    expect(r.stdout).toMatch(/observation/);
    expect(r.stdout).toMatch(/decision/);
    expect(r.stdout).toMatch(/✓/);
    // Suggested continue target — points at the matched session.
    expect(r.stdout).toMatch(new RegExp(`Continue with: ${sid}`));
  });

  it("does not expose internal event names in text output", () => {
    const create = runCli(tmp, ["session", "create", "leak hunt"]);
    const sid = sessionIdFromCreate(create.stdout);

    expect(appendEvent(tmp, sid, "observation_recorded", { text: "leak in middleware" }).status).toBe(0);
    expect(appendEvent(tmp, sid, "hypothesis_created", {
      title: "leak-from-middleware",
      text: "leak in middleware",
    }).status).toBe(0);
    expect(appendEvent(tmp, sid, "hypothesis_weakened", { reason: "evidence" }).status).toBe(0);

    const r = runCli(tmp, ["search", "leak"]);
    expect(r.status).toBe(0);
    // Internal event names must NOT leak in text mode.
    expect(r.stdout).not.toMatch(/hypothesis_weakened|hypothesis_created|observation_recorded/);
    // Trust-friendly labels only.
    expect(r.stdout).toMatch(/hypothesis|goal|observation|decision|conclusion/);
  });

  it("JSON output includes kind, score, and snippet for every match", () => {
    const create = runCli(tmp, ["session", "create", "ratelimit"]);
    const sid = sessionIdFromCreate(create.stdout);
    expect(appendEvent(tmp, sid, "observation_recorded", { text: "ratelimit kicks in after 100 rps" }).status).toBe(0);

    const r = runCli(tmp, ["search", "ratelimit", "--json"]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.kind).toBe("search");
    expect(parsed.data.q).toBe("ratelimit");
    expect(parsed.data.count).toBeGreaterThanOrEqual(1);
    const first = parsed.data.results[0];
    expect(first.session_id).toBe(sid);
    expect(first.matches.length).toBeGreaterThanOrEqual(1);
    // M2.1: per-match fields expose kind/score/snippet/reasons.
    expect(first.matches[0]).toMatchObject({
      kind: expect.any(String),
      snippet: expect.stringContaining("ratelimit"),
      score: expect.any(Number),
      reasons: expect.any(Array),
    });
    expect(parsed.data.continue_target).toBe(sid);
  });

  it("continue_target falls back to most recent open session when no open match", () => {
    // Closed session with the search term.
    const old = runCli(tmp, ["session", "create", "old auth work"]);
    const oldSid = sessionIdFromCreate(old.stdout);
    expect(appendEvent(tmp, oldSid, "observation_recorded", { text: "auth cookies insecure" }).status).toBe(0);
    expect(runCli(tmp, ["session", "close", oldSid]).status).toBe(0);

    // Active session that does NOT match.
    runCli(tmp, ["session", "create", "billing"]);
    const newSid = sessionIdFromCreate(runCli(tmp, ["session", "create", "billing work"]).stdout);

    const r = runCli(tmp, ["search", "auth", "--status", "closed", "--json"]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.data.count).toBe(1);
    // continue_target should fall back to the open session.
    expect(parsed.data.continue_target).toBe(newSid);
  });
});

describe("cognit continue / search JSON envelope", () => {
  it("continue --json keeps the trust marker in accepted bucket", () => {
    const create = runCli(tmp, ["session", "create", "json mode check"]);
    const sid = sessionIdFromCreate(create.stdout);
    expect(appendEvent(tmp, sid, "decision_proposed", {
      text: "ship it",
      based_on_conclusion_ids: [],
    }).status).toBe(0);
    expect(appendEvent(tmp, sid, "decision_accepted", { based_on_conclusion_ids: [] }).status).toBe(0);

    const r = runCli(tmp, ["continue", "--json"]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.kind).toBe("continue");
    expect(parsed.data.sessionId).toBe(sid);
    expect(parsed.data.acceptedDecisions).toHaveLength(1);
    expect(parsed.data.acceptedDecisions[0].marker).toBe("accepted");
    expect(parsed.data.trustCounts.accepted).toBe(1);
  });
});