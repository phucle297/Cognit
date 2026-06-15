import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import BetterSqlite3 from "better-sqlite3";

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
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cognit-finding-cli-"));
});

afterEach(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

describe("cognit finding", () => {
  it("appends a finding_created event with the typed payload and related_observation_ids", async () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
    const create = runCli(tmp, ["session", "create", "investigate the bug"]);
    expect(create.status).toBe(0);
    const idMatch = create.stdout.match(/session:\s+(01[A-Z0-9]+)/i);
    expect(idMatch).not.toBeNull();
    const sessionId = idMatch![1]!;

    // Create two observation ids we will reference as --related.
    const obs1 = runCli(tmp, ["observe", "first observation", "--session", sessionId]);
    expect(obs1.status).toBe(0);
    const obs1Id = (obs1.stdout.match(/event:\s+(01[A-Z0-9]+)/i) as RegExpMatchArray)[1]!;

    const obs2 = runCli(tmp, ["observe", "second observation", "--session", sessionId]);
    expect(obs2.status).toBe(0);
    const obs2Id = (obs2.stdout.match(/event:\s+(01[A-Z0-9]+)/i) as RegExpMatchArray)[1]!;

    const finding = runCli(tmp, [
      "finding",
      "the bug is caused by uninitialised token",
      "--session",
      sessionId,
      "--related",
      `${obs1Id},${obs2Id}`,
    ]);
    expect(finding.status).toBe(0);
    expect(finding.stdout).toMatch(/event:\s+01[A-Z0-9]+/i);
    expect(finding.stdout).toContain("type:     finding_created");
    expect(finding.stdout).toContain(`session:  ${sessionId}`);
    expect(finding.stdout).toMatch(/time:\s+\d{4}-\d{2}-\d{2}T/);

    // Open the DB directly and assert exactly one finding_created
    // event with the expected payload, including related_observation_ids.
    const dbPath = path.join(tmp, ".cognit", "cognit.db");
    const db = new BetterSqlite3(dbPath, { readonly: true });
    try {
      const rows = db
        .prepare(
          "SELECT id, type, payload_json FROM events WHERE session_id = ? AND type = ? ORDER BY created_at ASC",
        )
        .all(sessionId, "finding_created") as Array<{
        id: string;
        type: string;
        payload_json: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.type).toBe("finding_created");
      const payload = JSON.parse(rows[0]!.payload_json) as {
        text: string;
        related_observation_ids: string[];
      };
      expect(payload.text).toBe("the bug is caused by uninitialised token");
      expect(payload.related_observation_ids).toEqual([obs1Id, obs2Id]);
    } finally {
      db.close();
    }
  });
});
