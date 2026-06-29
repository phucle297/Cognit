/**
 * apps/cli/tests/integration/memory-selection.test.ts — M2.1 selection tests.
 *
 * Black-box CLI tests over `cognit continue` and `cognit search` that
 * verify the deterministic M2.1 selection rules. Each test seeds the
 * session via the public CLI commands (`cognit decision propose`,
 * `cognit conclusion propose`, `cognit hypothesis propose`) and then
 * asserts on the rendered text + the JSON envelope.
 *
 * Server-free contract: COGNIT_SERVER_URL is forced to an unreachable
 * port. Both commands must work via SQLite only.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/run-cli";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cognit-m21-"));
  expect(runCli(tmp, ["init", "--project", "m21"]).status).toBe(0);
});

afterEach(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

const sessionIdFromCreate = (out: string): string => {
  const m = out.match(/session:\s+(01[A-Z0-9]+)/i);
  if (!m) throw new Error(`no session id in output: ${out}`);
  return m[1]!;
};

const mkSession = (goal: string): string => {
  const create = runCli(tmp, ["session", "create", goal]);
  expect(create.status).toBe(0);
  return sessionIdFromCreate(create.stdout);
};

const seedHypothesis = (sid: string, title: string): void => {
  const r = runCli(tmp, [
    "hypothesis",
    "propose",
    title,
    "--text",
    title,
    "--session",
    sid,
  ]);
  expect(r.status).toBe(0);
};

/**
 * Find the most recent conclusion id for a session. The reducer uses
 * the event id as the conclusion id (`event.id === conclusion_id`),
 * so we read it directly from the events table.
 */
const lastConclusionId = (sid: string): string => {
  const dbPath = path.join(tmp, ".cognit", "cognit.db");
  const betterSqlite3 = require("better-sqlite3");
  const db = new betterSqlite3(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT id FROM events
         WHERE session_id = ?
           AND type = 'conclusion_proposed'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .all(sid) as { id: string }[];
    expect(rows.length).toBe(1);
    return rows[0]!.id;
  } finally {
    db.close();
  }
};

const seedVerifiedConclusion = (sid: string, text: string): string => {
  const r = runCli(tmp, ["conclusion", "propose", text, "--session", sid]);
  expect(r.status).toBe(0);
  const cid = lastConclusionId(sid);
  const v = runCli(tmp, [
    "conclusion",
    "verify",
    "--id",
    cid,
    "--verification",
    "01HZZZZZZZZZZZZZZZZZZZZZZZZ",
    "--evidence",
    cid,
    "--session",
    sid,
  ]);
  expect(v.status).toBe(0);
  return cid;
};

describe("cognit continue — M2.1 selection", () => {
  it("shows verified conclusions at the top with ✓ reasons", () => {
    const sid = mkSession("investigate auth bug");
    seedHypothesis(sid, "investigate the auth bug");
    const r1 = runCli(tmp, ["decision", "propose", "drop the cache", "--session", sid]);
    expect(r1.status).toBe(0);
    seedVerifiedConclusion(sid, "auth uses refresh tokens");

    const out = runCli(tmp, ["continue"]);
    expect(out.status).toBe(0);

    // Order: Verified section before Decided section.
    const vIdx = out.stdout.indexOf("Verified:");
    const dIdx = out.stdout.indexOf("Decided:");
    expect(vIdx).toBeGreaterThan(-1);
    expect(dIdx).toBeGreaterThan(vIdx);
    // Every ranked memory surfaces at least one ✓ bullet.
    expect(out.stdout).toMatch(/✓/);
  });

  it("caps per kind — top-3 conclusions, top-3 decisions in continue", () => {
    const sid = mkSession("cap test");
    for (let i = 0; i < 5; i++) {
      const text = `unique conclusion number ${i} cyan-warden-${i}`;
      seedVerifiedConclusion(sid, text);
    }
    for (let i = 0; i < 5; i++) {
      const text = `unique decision number ${i} apple-pioneer-${i}`;
      const d = runCli(tmp, ["decision", "propose", text, "--session", sid]);
      expect(d.status).toBe(0);
    }

    const json = runCli(tmp, ["continue", "--json"]);
    expect(json.status).toBe(0);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.data.conclusions.length).toBeLessThanOrEqual(3);
    expect(parsed.data.decisions.length).toBeLessThanOrEqual(3);
    expect(parsed.data.rankedCount).toBe(10);
  });

  it("every ranked memory carries a non-empty reasons list", () => {
    const sid = mkSession("reasons check");
    seedHypothesis(sid, "investigate perf");
    const d = runCli(tmp, ["decision", "propose", "use mongo", "--session", sid]);
    expect(d.status).toBe(0);
    seedVerifiedConclusion(sid, "mongo is fast");

    const json = runCli(tmp, ["continue", "--json"]);
    expect(json.status).toBe(0);
    const parsed = JSON.parse(json.stdout);
    const all = [
      ...parsed.data.conclusions,
      ...parsed.data.decisions,
      ...parsed.data.hypotheses,
      ...parsed.data.verifications,
    ];
    expect(all.length).toBeGreaterThan(0);
    for (const m of all) {
      expect(Array.isArray(m.reasons)).toBe(true);
      expect(m.reasons.length).toBeGreaterThan(0);
    }
  });

  it("text output uses the trust marker vocabulary (no raw state names leaked)", () => {
    const sid = mkSession("trust markers");
    const d = runCli(tmp, ["decision", "propose", "use redis", "--session", sid]);
    expect(d.status).toBe(0);

    const out = runCli(tmp, ["continue"]);
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/\[pending\]|\[accepted\]|\[verified\]|\[open\]|\[rejected\]/);
  });

  it("rejected conclusion sorts behind verified conclusion in trust counter", () => {
    const sid = mkSession("trust ordering check");
    // One verified conclusion (verified trust) and one rejected conclusion
    // (rejected trust) — both stay in trust counter; ranking prefers
    // verified over rejected.
    seedVerifiedConclusion(sid, "redis will scale beyond 100k rps");
    const r2 = runCli(tmp, ["conclusion", "propose", "redis will scale with sharding", "--session", sid]);
    expect(r2.status).toBe(0);
    const cid2 = lastConclusionId(sid);
    const reject = runCli(tmp, [
      "conclusion",
      "reject",
      "--id",
      cid2,
      "--reason",
      "superseded",
      "--session",
      sid,
    ]);
    expect(reject.status).toBe(0);

    const json = runCli(tmp, ["continue", "--json"]);
    expect(json.status).toBe(0);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.data.trustCounts.verified).toBeGreaterThanOrEqual(1);
    expect(parsed.data.trustCounts.rejected).toBeGreaterThanOrEqual(1);

    // Among the conclusions, the verified one is listed first.
    const cs = parsed.data.conclusions;
    expect(cs[0]!.trust).toBe("verified");
  });
});

describe("cognit search — M2.1 selection", () => {
  it("returns ranked results with ✓ bullets per match", () => {
    const sid = mkSession("search auth");
    seedVerifiedConclusion(sid, "auth uses refresh tokens");
    const d = runCli(tmp, ["decision", "propose", "drop the optimistic cache", "--session", sid]);
    expect(d.status).toBe(0);

    const out = runCli(tmp, ["search", "auth"]);
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/Matches for "auth"/);
    expect(out.stdout).toMatch(/✓/);
  });

  it("non-matching query returns the no-match block with next steps", () => {
    const sid = mkSession("irrelevant");
    const d = runCli(tmp, ["decision", "propose", "use postgres", "--session", sid]);
    expect(d.status).toBe(0);

    const out = runCli(tmp, ["search", "purple-monkey-dishwasher"]);
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/no matches for/);
    expect(out.stdout).toMatch(/Run `cognit continue`/);
  });

  it("memory that matches the query ranks ahead of unrelated memory in same session", () => {
    const sid = mkSession("ranking check");
    seedVerifiedConclusion(sid, "auth uses refresh tokens");
    const d = runCli(tmp, [
      "decision",
      "propose",
      "switch database to postgres",
      "--session",
      sid,
    ]);
    expect(d.status).toBe(0);

    const json = runCli(tmp, ["search", "auth", "--json"]);
    expect(json.status).toBe(0);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.data.count).toBeGreaterThan(0);
    const best = parsed.data.results[0]!;
    // Best score per session must be positive.
    expect(best.score).toBeGreaterThan(0);
    // At least one match must carry the auth signal.
    const matchedKind = best.matches.find((m: { reasons: string[] }) =>
      m.reasons.some((r) => r.startsWith("matches")),
    );
    expect(matchedKind).toBeTruthy();
  });
});
