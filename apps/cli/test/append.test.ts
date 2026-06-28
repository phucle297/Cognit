import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import BetterSqlite3 from "better-sqlite3";
import YAML from "yaml";

const CLI_ENTRY = path.resolve(__dirname, "..", "src", "index.ts");
const TSX = path.resolve(__dirname, "..", "node_modules", ".bin", "tsx");

function runCli(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(TSX, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

let tmp: string;

beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cognit-append-cli-"));
});

afterEach(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

describe("cognit append", () => {
  it("appends an observation_recorded event to an active session", async () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
    const create = runCli(tmp, ["session", "create", "watch this"]);
    expect(create.status).toBe(0);
    const idMatch = create.stdout.match(/session:\s+(01[A-Z0-9]+)/i);
    expect(idMatch).not.toBeNull();
    const id = idMatch![1]!;

    const append = runCli(tmp, [
      "append",
      "--type",
      "observation_recorded",
      "--payload",
      '{"text":"hello world"}',
      "--session",
      id,
    ]);
    expect(append.status).toBe(0);
    expect(append.stdout).toMatch(/event:\s+01[A-Z0-9]+/i);
    expect(append.stdout).toContain("type:     observation_recorded");
    expect(append.stdout).toContain(`session:  ${id}`);
  });

  it("reads --payload from a .json file path", async () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
    const create = runCli(tmp, ["session", "create", "file payload"]);
    const idMatch = create.stdout.match(/session:\s+(01[A-Z0-9]+)/i);
    const id = idMatch![1]!;

    const payloadFile = path.join(tmp, "obs.json");
    fs.writeFileSync(payloadFile, JSON.stringify({ text: "from file" }));

    const append = runCli(tmp, [
      "append",
      "--type",
      "observation_recorded",
      "--payload",
      payloadFile,
      "--session",
      id,
    ]);
    expect(append.status).toBe(0);
    expect(append.stdout).toMatch(/event:\s+01[A-Z0-9]+/i);
  });

  it("fails cleanly when --payload file is missing", async () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
    const create = runCli(tmp, ["session", "create", "missing payload"]);
    const idMatch = create.stdout.match(/session:\s+(01[A-Z0-9]+)/i);
    const id = idMatch![1]!;

    const append = runCli(tmp, [
      "append",
      "--type",
      "observation_recorded",
      "--payload",
      "/nonexistent/path/to/payload.json",
      "--session",
      id,
    ]);
    expect(append.status).not.toBe(0);
    expect(append.stderr).toContain("file not found");
  });

  it("fails cleanly when --type is unknown", async () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
    const create = runCli(tmp, ["session", "create", "bad type"]);
    const idMatch = create.stdout.match(/session:\s+(01[A-Z0-9]+)/i);
    const id = idMatch![1]!;

    const append = runCli(tmp, [
      "append",
      "--type",
      "this_is_not_a_real_type",
      "--payload",
      '{"text":"x"}',
      "--session",
      id,
    ]);
    expect(append.status).not.toBe(0);
    expect(append.stderr).toContain("not a known event type");
  });

  it("auto-recovers when --session does not exist (M1.1: forgiving)", async () => {
    // M1.1 contract: an unknown explicit --session falls through to
    // auto-create rather than failing the LLM call. This matches the
    // auto-session behaviour for every other write verb.
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);

    const append = runCli(tmp, [
      "append",
      "--type",
      "observation_recorded",
      "--payload",
      '{"text":"x"}',
      "--session",
      "01ZZZZZZZZZZZZZZZZZZZZZZZZ",
    ]);
    expect(append.status).toBe(0);
    expect(append.stderr).toContain("created session");
  });

  it("rejects --actor with an invalid type", async () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
    const create = runCli(tmp, ["session", "create", "bad actor"]);
    const idMatch = create.stdout.match(/session:\s+(01[A-Z0-9]+)/i);
    const id = idMatch![1]!;

    const append = runCli(tmp, [
      "append",
      "--type",
      "observation_recorded",
      "--payload",
      '{"text":"x"}',
      "--session",
      id,
      "--actor",
      "alice:robot",
    ]);
    expect(append.status).not.toBe(0);
    expect(append.stderr).toContain("human|worker|system");
  });

  it("fails when not in a cognit project", async () => {
    const append = runCli(tmp, [
      "append",
      "--type",
      "observation_recorded",
      "--payload",
      '{"text":"x"}',
      "--session",
      "01AAAAAAAAAAAAAAAAAAAAAAAA",
    ]);
    expect(append.status).not.toBe(0);
    expect(append.stderr).toContain("no .cognit/cognit.yaml found");
  });
});

describe("auto-snapshot trigger", () => {
  it("writes a snapshot row after everyN appends when session.snapshot_every_n_events is set", async () => {
    // 1. init a fresh project in tmp.
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);

    // 2. Edit cognit.yaml to set snapshot_every_n_events: 3. The
    //    file is hand-edited (not via a CLI command) so the test
    //    exercises the read-path that derives SessionPolicy from the
    //    on-disk config.
    const configPath = path.join(tmp, ".cognit", "cognit.yaml");
    const original = fs.readFileSync(configPath, "utf8");
    // Parse + mutate + stringify rather than a brittle regex over the
    // sorted top-level keys.
    const parsed = YAML.parse(original) as Record<string, unknown>;
    parsed.session = {
      ...((parsed.session ?? {}) as Record<string, unknown>),
      snapshot_every_n_events: 3,
    };
    const updated = YAML.stringify(parsed, { indent: 2, sortMapEntries: true });
    fs.writeFileSync(configPath, updated, "utf8");

    // 3. Create a session and capture its id.
    const create = runCli(tmp, ["session", "create", "auto-snapshot e2e"]);
    expect(create.status).toBe(0);
    const idMatch = create.stdout.match(/session:\s+(01[A-Z0-9]+)/i);
    expect(idMatch).not.toBeNull();
    const sessionId = idMatch![1]!;

    // 4. Append three events. With everyN=3 and TWO pre-existing
    //    rows in events (actor_registered + session_created, the
    //    Cognit-ttc audit side-effect on first ensureActor), the
    //    1st append brings the count to 3 (crosses threshold ->
    //    snapshot: yes), the 2nd is event #4 (4-3=1 < 3, no snap),
    //    the 3rd is event #5 (5-3=2 < 3, no new snap).
    const results: { stdout: string }[] = [];
    for (const text of ["a", "b", "c"]) {
      const out = runCli(tmp, [
        "append",
        "--type",
        "observation_recorded",
        "--payload",
        JSON.stringify({ text }),
        "--session",
        sessionId,
      ]);
      expect(out.status).toBe(0);
      results.push({ stdout: out.stdout });
    }

    // 5. Stdout contract: append reports `snapshot: yes|no`.
    expect(results[0]!.stdout).toContain("snapshot: yes");
    expect(results[1]!.stdout).toContain("snapshot: no");
    expect(results[2]!.stdout).toContain("snapshot: no");

    // 6. Open the DB directly and assert exactly one snapshot row.
    const dbPath = path.join(tmp, ".cognit", "cognit.db");
    const db = new BetterSqlite3(dbPath, { readonly: true });
    try {
      const count = db
        .prepare("SELECT COUNT(*) as n FROM snapshots WHERE session_id = ?")
        .get(sessionId) as { n: number };
      expect(count.n).toBe(1);

      const row = db
        .prepare("SELECT event_count, event_id FROM snapshots WHERE session_id = ?")
        .get(sessionId) as { event_count: number; event_id: string };
      expect(row.event_count).toBe(3);
    } finally {
      db.close();
    }
  });
});
