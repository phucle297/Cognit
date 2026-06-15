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
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cognit-observation-cli-"));
});

afterEach(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

describe("cognit observe", () => {
  it("appends an observation_recorded event with the typed payload", async () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
    const create = runCli(tmp, ["session", "create", "watch this"]);
    expect(create.status).toBe(0);
    const idMatch = create.stdout.match(/session:\s+(01[A-Z0-9]+)/i);
    expect(idMatch).not.toBeNull();
    const sessionId = idMatch![1]!;

    const observe = runCli(tmp, ["observe", "hello world", "--session", sessionId]);
    expect(observe.status).toBe(0);
    expect(observe.stdout).toMatch(/event:\s+01[A-Z0-9]+/i);
    expect(observe.stdout).toContain("type:     observation_recorded");
    expect(observe.stdout).toContain(`session:  ${sessionId}`);
    expect(observe.stdout).toMatch(/time:\s+\d{4}-\d{2}-\d{2}T/);

    // Open the DB directly and assert exactly one observation_recorded
    // event with the expected payload.
    const dbPath = path.join(tmp, ".cognit", "cognit.db");
    const db = new BetterSqlite3(dbPath, { readonly: true });
    try {
      const rows = db
        .prepare(
          "SELECT id, type, payload_json FROM events WHERE session_id = ? AND type = ? ORDER BY created_at ASC",
        )
        .all(sessionId, "observation_recorded") as Array<{
        id: string;
        type: string;
        payload_json: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.type).toBe("observation_recorded");
      const payload = JSON.parse(rows[0]!.payload_json) as { text: string };
      expect(payload.text).toBe("hello world");
    } finally {
      db.close();
    }
  });
});
