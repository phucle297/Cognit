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
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cognit-decision-cli-"));
});

afterEach(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

describe("cognit decision", () => {
  it("propose appends a decision_proposed event with the typed payload", async () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
    const create = runCli(tmp, ["session", "create", "decide something"]);
    expect(create.status).toBe(0);
    const idMatch = create.stdout.match(/session:\s+(01[A-Z0-9]+)/i);
    expect(idMatch).not.toBeNull();
    const sessionId = idMatch![1]!;

    const propose = runCli(tmp, [
      "decision",
      "propose",
      "use Postgres for the user store",
      "--session",
      sessionId,
      "--based-on",
      "c_01,c_02",
    ]);
    expect(propose.status).toBe(0);
    expect(propose.stdout).toMatch(/event:\s+01[A-Z0-9]+/i);
    expect(propose.stdout).toContain("type:     decision_proposed");
    expect(propose.stdout).toContain(`session:  ${sessionId}`);
    expect(propose.stdout).toMatch(/time:\s+\d{4}-\d{2}-\d{2}T/);

    // Open the DB directly and assert exactly one decision_proposed
    // event with the expected payload (text + based_on_conclusion_ids).
    const dbPath = path.join(tmp, ".cognit", "cognit.db");
    const db = new BetterSqlite3(dbPath, { readonly: true });
    try {
      const rows = db
        .prepare(
          "SELECT id, type, payload_json FROM events WHERE session_id = ? AND type = ? ORDER BY created_at ASC",
        )
        .all(sessionId, "decision_proposed") as Array<{
        id: string;
        type: string;
        payload_json: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.type).toBe("decision_proposed");
      const payload = JSON.parse(rows[0]!.payload_json) as {
        text: string;
        based_on_conclusion_ids: string[];
      };
      expect(payload.text).toBe("use Postgres for the user store");
      expect(payload.based_on_conclusion_ids).toEqual(["c_01", "c_02"]);
    } finally {
      db.close();
    }
  });
});
